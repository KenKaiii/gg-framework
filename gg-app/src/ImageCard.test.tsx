// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./agent", () => ({ saveChatImage: vi.fn() }));
vi.mock("./toast", () => ({ toast: vi.fn() }));

import { saveChatImage } from "./agent";
import { toast } from "./toast";
import { ImageCard } from "./ImageCard";

const save = vi.mocked(saveChatImage);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ImageCard", () => {
  it("opens the file from the image and saves the original file from its own button", async () => {
    save.mockResolvedValue("/Users/me/Pictures/loop.gif");
    const onOpen = vi.fn();
    render(
      <ImageCard
        src="data:image/gif;base64,R0lGODlh"
        alt="loop"
        path="/p/.gg/generated/loop.gif"
        caption="loop.gif"
        onOpen={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save loop.gif" }));
    // Saving never opens the image as well.
    expect(onOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Saved loop.gif", "success"));
    expect(save).toHaveBeenCalledWith({
      path: "/p/.gg/generated/loop.gif",
      src: "data:image/gif;base64,R0lGODlh",
      directory: null,
    });
    // The next save starts in the folder this one went to.
    expect(localStorage.getItem("gg-image-dir")).toBe("/Users/me/Pictures");

    fireEvent.click(screen.getByRole("button", { name: "Open loop.gif" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("saves an image with no file from its data, quietly when cancelled", async () => {
    save.mockResolvedValue(null);
    render(<ImageCard src="data:image/png;base64,iVBORw0K" alt="pasted" />);
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save image" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(toast).not.toHaveBeenCalled();
  });

  it("opens and saves an image inside a link without following the link", async () => {
    save.mockResolvedValue(null);
    const onOpen = vi.fn();
    const followed = vi.fn((e: React.MouseEvent) => {
      if (!e.defaultPrevented) e.preventDefault();
      return !e.defaultPrevented;
    });
    render(
      <a href="https://example.com" onClick={followed}>
        <ImageCard
          inline
          src="data:image/png;base64,iVBORw0K"
          alt="x"
          path="x.png"
          caption="x.png"
          onOpen={onOpen}
        />
      </a>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open x.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Save x.png" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(followed).not.toHaveBeenCalled();
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
  });

  it("says why a save failed", async () => {
    save.mockRejectedValue("Permission denied (os error 13)");
    render(<ImageCard src="data:image/png;base64,iVBORw0K" alt="x" caption="x.png" path="x.png" />);
    fireEvent.click(screen.getByRole("button", { name: "Save x.png" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Could not save image: Permission denied (os error 13)",
        "error",
      ),
    );
  });
});
