import { crc32, deflateSync } from "node:zlib";
import { befriend, expect, friendList, newUser, test } from "./fixtures";

// アイコンの画像（docs/specs/T-27-avatar-upload.md「E2Eテスト」）

/** 単色の PNG（ブラウザが読めて、端末で 256×256 の JPEG に作り直される） */
function png(width: number, height: number, rgb: [number, number, number]) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const photo = { name: "photo.png", mimeType: "image/png", buffer: png(400, 300, [40, 120, 200]) };

test("設定で画像を選んでアイコンにし、友達の一覧にも出る。外すと1文字めに戻る", async ({ browser }) => {
  const a = await newUser(browser, "Aki");
  const b = await newUser(browser, "Bee");
  await befriend(a, b);

  await a.page.goto("/settings/account");
  const section = a.page.locator("section", { has: a.page.getByRole("heading", { name: "アイコン" }) });
  await section.getByLabel("画像を選ぶ").setInputFiles(photo);
  await section.getByRole("button", { name: "この画像にする" }).click();
  await expect(section.getByText("アイコンを変えました")).toBeVisible();
  // 自分のアイコンが画像になる（署名つき URL を読めている）
  const mine = section.locator('img[src^="/api/v1/avatars/"]');
  await expect(mine).toBeVisible();
  await expect.poll(() => mine.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256);

  // 友達の一覧に、a のアイコンが画像で出る
  await b.page.goto("/friends");
  const row = friendList(b.page).getByRole("listitem").filter({ hasText: a.displayName });
  const theirs = row.locator('img[src^="/api/v1/avatars/"]');
  await expect(theirs).toBeVisible();
  await expect.poll(() => theirs.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256);

  // 外すと1文字めに戻る
  await section.getByRole("button", { name: "アイコンを外す" }).click();
  await expect(section.getByText("アイコンを外しました")).toBeVisible();
  await expect(section.locator("img")).toHaveCount(0);
  await b.page.reload();
  await expect(friendList(b.page).getByText(a.displayName)).toBeVisible();
  await expect(row.locator("img")).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});
