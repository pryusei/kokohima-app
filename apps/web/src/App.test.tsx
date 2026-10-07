import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("サービス名の見出しを表示する", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "ここ暇" })).toBeVisible();
  });
});
