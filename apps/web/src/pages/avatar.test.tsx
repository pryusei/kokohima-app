import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { centerSquare, MAX_SOURCE_BYTES } from "../account/avatarImage";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { Avatar, useAvatarImage } from "../ui/Avatar";

// アイコンの画像（docs/specs/T-27-avatar-upload.md「端末での作り直し」「画面」）

const ID = "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11";
const URL_1 = "/api/v1/avatars/0b8f7a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b?e=1760061600&s=abc";
const me = (avatarUrl: string | null) => ({ id: ID, displayName: "ゆう", avatarUrl });

/** 端末での作り直しの記録（jsdom には canvas がないので差し替える） */
type Drawn = { canvas: { width: number; height: number }; draw: number[]; type: string; quality: number };
let drawn: Drawn[];
let bitmapSize: { width: number; height: number };
let decodeFails: boolean;

beforeEach(() => {
  tokenStore.clear();
  drawn = [];
  bitmapSize = { width: 400, height: 300 };
  decodeFails = false;
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      if (decodeFails) throw new DOMException("bad", "InvalidStateError");
      return { ...bitmapSize, close: () => undefined };
    }),
  );
  const record: Drawn = { canvas: { width: 0, height: 0 }, draw: [], type: "", quality: 0 };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    record.canvas = { width: this.width, height: this.height };
    return {
      fillRect: () => undefined,
      drawImage: (_b: unknown, ...args: number[]) => {
        record.draw = args;
      },
    } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb, type, quality) => {
    record.type = String(type);
    record.quality = Number(quality);
    drawn.push({ ...record });
    cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const file = (size = 1000, type = "image/png") => new File([new Uint8Array(size)], "photo.png", { type });

async function openAccount(routes: Parameters<typeof mockFetch>[0]) {
  window.history.replaceState(null, "", "/settings/account");
  const mocked = mockFetch({ "/api/v1/auth/refresh": json(tokenBody()), ...routes });
  renderApp();
  const section = (await screen.findByRole("heading", { name: "アイコン" })).closest("section") as HTMLElement;
  await within(section).findByLabelText("画像を選ぶ");
  return { ...mocked, section };
}

const pick = (section: HTMLElement, f: File) => userEvent.upload(within(section).getByLabelText("画像を選ぶ"), f);

describe("アイコンの画像の設定", () => {
  it("画像を選ぶと 256×256 の JPEG（品質 0.85）に作り直し、確認のあと PUT で送る", async () => {
    const { calls, section } = await openAccount({ "/api/v1/me": json(me(null)), "/api/v1/me/avatar": json(me(URL_1)) });
    expect(within(section).queryByRole("button", { name: "アイコンを外す" })).toBeNull();
    await pick(section, file());
    const confirm = await within(section).findByRole("button", { name: "この画像にする" });
    // 中央の正方形（400×300 → 横に50ずらした 300×300）を 256×256 に
    expect(drawn.at(-1)).toEqual({ canvas: { width: 256, height: 256 }, draw: [50, 0, 300, 300, 0, 0, 256, 256], type: "image/jpeg", quality: 0.85 });
    // 大きな写真を元の解像度で展開しないよう、縮めて読む
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(File), { imageOrientation: "from-image", resizeWidth: 1024, resizeQuality: "high" });
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/me/avatar" && c.init.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.init.method === "PUT")!;
    expect(new Headers(put.init.headers).get("Content-Type")).toBe("image/jpeg");
    expect(put.init.body).toBeInstanceOf(Blob);
    expect(await within(section).findByText("アイコンを変えました")).toBeVisible();
    expect(within(section).getByRole("button", { name: "アイコンを外す" })).toBeVisible();
    // 画像はメモリにだけ置く
    expect(JSON.stringify({ ...localStorage })).not.toContain("avatar");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("avatar");
  });

  it("「やめる」で送らずに戻る", async () => {
    const { calls, section } = await openAccount({ "/api/v1/me": json(me(null)) });
    await pick(section, file());
    await userEvent.click(await within(section).findByRole("button", { name: "やめる" }));
    expect(within(section).queryByRole("button", { name: "この画像にする" })).toBeNull();
    expect(calls.some((c) => c.url === "/api/v1/me/avatar")).toBe(false);
  });

  it("読めない画像・20MB を超える画像は送らずに静かな文を出す", async () => {
    const { calls, section } = await openAccount({ "/api/v1/me": json(me(null)) });
    decodeFails = true;
    await pick(section, file());
    const message = await within(section).findByText("この画像は使えません。ほかの画像を選んでください。");
    expect(message).toBeVisible();
    // 赤やエラー色を使わない
    expect(message.className).toContain("text-ink-muted");
    decodeFails = false;
    await pick(section, file(MAX_SOURCE_BYTES + 1));
    expect(await within(section).findByText("この画像は使えません。ほかの画像を選んでください。")).toBeVisible();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.url === "/api/v1/me/avatar")).toBe(false);
  });

  it("送るのに失敗したら静かな文を出し、確認の画面に残る", async () => {
    const { section } = await openAccount({
      "/api/v1/me": json(me(null)),
      "/api/v1/me/avatar": json({ type: "about:blank", title: "x", status: 400, code: "validation_failed", requestId: "r" }, 400),
    });
    await pick(section, file());
    await userEvent.click(await within(section).findByRole("button", { name: "この画像にする" }));
    expect(await within(section).findByText("アイコンを変えられませんでした。もう一度お試しください。")).toBeVisible();
    expect(within(section).getByRole("button", { name: "この画像にする" })).toBeVisible();
  });

  it("「アイコンを外す」で DELETE を送り、1文字めに戻る", async () => {
    const { calls, section } = await openAccount({
      "/api/v1/me": json(me(URL_1)),
      "/api/v1/me/avatar": () => new Response(null, { status: 204 }),
    });
    await userEvent.click(await within(section).findByRole("button", { name: "アイコンを外す" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/me/avatar" && c.init.method === "DELETE")).toBe(true));
    expect(await within(section).findByText("アイコンを外しました")).toBeVisible();
    expect(within(section).queryByRole("button", { name: "アイコンを外す" })).toBeNull();
    expect(section.querySelector("img")).toBeNull();
  });
});

describe("Avatar", () => {
  it("画像があれば出し、読めなければ表示名の1文字めに戻る", () => {
    const { container, rerender } = render(<Avatar name="ゆう" src={URL_1} />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", URL_1);
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(img).toHaveAttribute("alt", "");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("ゆ");
    // URL が変われば、もう一度読む
    rerender(<Avatar name="ゆう" src={`${URL_1}x`} />);
    expect(container.querySelector("img")).not.toBeNull();
    // 読めなかったあと、オンラインに戻ったら読み直す
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(container.querySelector("img")).not.toBeNull();
    rerender(<Avatar name={null} src={null} />);
    expect(container.textContent).toBe("？");
  });

  it("友達の一覧で、友達のアイコンに画像が出る", async () => {
    window.history.replaceState(null, "", "/friends");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/friends": json({
        items: [{ id: ID, displayName: "あき", avatarUrl: URL_1, sharesMyAvailability: true, friendsSince: "2026-10-01T00:00:00.000Z" }],
        nextCursor: null,
      }),
      "/api/v1/invite-links": json({ items: [], nextCursor: null }),
      "/api/v1/me": json(me(null)),
    });
    const { container } = renderApp();
    await screen.findByText("あき");
    expect(container.querySelector(`img[src="${URL_1}"]`)).not.toBeNull();
  });
});

describe("useAvatarImage", () => {
  // Avatar と成立の演出の丸で共有する（docs/specs/T-58-meet-moment-avatars.md「5.」）
  it("読めなかった（error）ら出さず、URL が変わるか、オンラインに戻ると読み直す", () => {
    const { result, rerender } = renderHook(({ src }: { src: string | null }) => useAvatarImage(src), {
      initialProps: { src: URL_1 as string | null },
    });
    expect(result.current.showImage).toBe(true);
    act(() => result.current.onError());
    expect(result.current.showImage).toBe(false);
    rerender({ src: `${URL_1}x` });
    expect(result.current.showImage).toBe(true);
    act(() => result.current.onError());
    expect(result.current.showImage).toBe(false);
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current.showImage).toBe(false);
    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current.showImage).toBe(true);
    rerender({ src: null });
    expect(result.current.showImage).toBe(false);
  });
});

describe("centerSquare", () => {
  it("短い辺に合わせた中央の正方形", () => {
    expect(centerSquare(400, 300)).toEqual({ sx: 50, sy: 0, side: 300 });
    expect(centerSquare(300, 401)).toEqual({ sx: 0, sy: 50, side: 300 });
    expect(centerSquare(256, 256)).toEqual({ sx: 0, sy: 0, side: 256 });
  });
});
