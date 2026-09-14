// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCollectionPage } from "./useCollectionPage.js";

afterEach(cleanup);
function Fleet({ size = 2000 }: { size?: number }) {
  const page = useCollectionPage(Array.from({ length: size }, (_, id) => `agent-${id}`), "agents", item => item);
  return <>{page.controls}<ul>{page.visible.map(item => <li key={item}>{item}</li>)}</ul></>;
}

it("keeps every member searchable while rendering only one page of a 2,000-agent fleet", () => {
  render(<Fleet />);
  expect(screen.getAllByRole("listitem")).toHaveLength(50);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getAllByRole("listitem")[0]?.textContent).toBe("agent-50");
  fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), { target: { value: "agent-1999" } });
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText("agent-1999")).toBeTruthy();
  expect(screen.getByText("1 of 2000 agents. Page 1 of 1.")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), { target: { value: "" } });
  expect(screen.getAllByRole("listitem")[0]?.textContent).toBe("agent-0");
});

it("keeps an ordinary small fleet visible without pagination controls", () => {
  render(<Fleet size={5} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  expect(screen.queryByRole("navigation")).toBeNull();
});
