// メールの色（docs/specs/T-23-rich-mail.md「色」）
// メールでは CSS 変数が使えないので、apps/web/src/index.css のトークン（--kh-<キー>）の値を写す。
// トークンを変えたら一緒に直す（mail.test.ts が index.css と一致することを確かめる）

export const MAIL_TOKENS = [
  "bg",
  "surface",
  "surface-sunken",
  "ink",
  "ink-muted",
  "line",
  "lamp",
  "on-lamp",
  "meet",
  "on-meet",
  "quiet-bg",
  "quiet-ink",
  "action",
  "on-action",
] as const;

export type MailToken = (typeof MAIL_TOKENS)[number];
export type MailTheme = Record<MailToken, string>;

export const LIGHT: MailTheme = {
  bg: "#f8f7f6",
  surface: "#ffffff",
  "surface-sunken": "#f2f1f0",
  ink: "#23221e",
  "ink-muted": "#706d65",
  line: "#d6d3d0",
  lamp: "#ffcc17",
  "on-lamp": "#23221e",
  meet: "#0f7f85",
  "on-meet": "#ffffff",
  "quiet-bg": "#edebe8",
  "quiet-ink": "#65625b",
  action: "#0077c7",
  "on-action": "#ffffff",
};

export const DARK: MailTheme = {
  bg: "#1b1a17",
  surface: "#262521",
  "surface-sunken": "#141311",
  ink: "#f2f1f0",
  "ink-muted": "#b3afa8",
  line: "#3b3934",
  lamp: "#ffcc17",
  "on-lamp": "#23221e",
  meet: "#3fb8bf",
  "on-meet": "#0b2a2c",
  "quiet-bg": "#2e2c28",
  "quiet-ink": "#b3afa8",
  action: "#4da3e8",
  "on-action": "#0b1b29",
};
