import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChunkLoadError, lazyPage } from "./lazyPage";

// docs/specs/T-49-perf-small-fixes.md「4.」

describe("lazyPage", () => {
  it("読めたら、名前付きの export のページを出す", async () => {
    const Page = lazyPage(
      () => Promise.resolve({ Named: () => <h1>本文</h1> }),
      (m) => m.Named,
    );
    render(
      <Suspense fallback={<p>読み込み中</p>}>
        <Page />
      </Suspense>,
    );
    expect(await screen.findByRole("heading", { name: "本文" })).toBeVisible();
  });

  it("チャンクを読めなかったら、画面を落とさず静かに知らせる（エラーの色・alert を使わない）", async () => {
    const Page = lazyPage(
      () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
      () => () => <h1>本文</h1>,
    );
    render(
      <Suspense fallback={<p>読み込み中</p>}>
        <Page />
      </Suspense>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("読み込めませんでした。通信状態を確認して、もう一度お試しください");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "もう一度" })).toBeVisible();
  });

  it("「もう一度」でページを読み直す", async () => {
    const reload = vi.fn();
    render(<ChunkLoadError reload={reload} />);
    await userEvent.click(screen.getByRole("button", { name: "もう一度" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
