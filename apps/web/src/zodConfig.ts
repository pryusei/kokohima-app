import { config } from "zod";

// 画面の CSP（script-src 'self'。docs/specs/T-12-release.md）では eval・new Function を許さない。
// Zod は最初の検証で new Function を試し、捕まえても CSP の違反が報告されるので、試さない設定にする（検証の結果は同じ）
config({ jitless: true });
