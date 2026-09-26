import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { parseSgrMouse } from "@oh-my-pi/pi-tui/mouse";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { defaultEditorTheme } from "./test-themes";

const WIDTH = 20;
const LEFT_CLICK = parseSgrMouse("\x1b[<0;1;1M")!;

function plainRows(editor: Editor): string[] {
	return editor.render(WIDTH).map(row => Bun.stripANSI(row));
}

/** Rendered row and cell column where `needle` starts (cells, not code units). */
function locate(rows: readonly string[], needle: string): { line: number; col: number } {
	const line = rows.findIndex(row => row.includes(needle));
	expect(line).toBeGreaterThanOrEqual(0);
	const row = rows[line]!;
	return { line, col: visibleWidth(row.slice(0, row.indexOf(needle))) };
}

function focusedEditor(): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.focused = true;
	return editor;
}

function click(editor: Editor, line: number, col: number): void {
	editor.routeMouse(LEFT_CLICK, line, col);
}

describe("Editor click-to-place", () => {
	it("maps a click on a soft-wrapped continuation row to its logical column", () => {
		const editor = focusedEditor();
		editor.setText("alpha beta gamma delta");
		const rows = plainRows(editor);
		const delta = locate(rows, "delta");
		// "delta" wrapped onto the second visual row, not the first.
		expect(delta.line).toBe(locate(rows, "gamma").line);
		expect(delta.line).toBeGreaterThan(locate(rows, "alpha").line);

		click(editor, delta.line, delta.col);
		editor.handleInput("X");
		expect(editor.getText()).toBe("alpha beta gamma Xdelta");
	});

	it("resolves rows through the scroll offset of a height-capped editor", () => {
		const editor = focusedEditor();
		editor.setMaxHeight(4);
		editor.setText("line0\nline1\nline2\nline3\nline4");
		const rows = plainRows(editor);
		// The cursor sits on the last line, so the first lines are scrolled away.
		expect(rows.some(row => row.includes("line0"))).toBe(false);
		const target = locate(rows, "line3");

		click(editor, target.line, target.col + 4);
		expect(editor.getCursor()).toEqual({ line: 3, col: 4 });
	});

	it("lands a click past a row's end at that row's end", () => {
		const editor = focusedEditor();
		editor.setText("short\nalpha beta gamma delta");
		const rows = plainRows(editor);
		const farRight = WIDTH - 4;

		// Last (only) segment of a logical line: after its final character.
		click(editor, locate(rows, "short").line, farRight);
		expect(editor.getCursor()).toEqual({ line: 0, col: 5 });

		// A wrapped row's end is the wrap point: typing continues the row's last word.
		click(editor, locate(rows, "alpha").line, farRight);
		editor.handleInput("X");
		expect(editor.getText()).toBe("short\nalpha betaX gamma delta");
	});

	it("snaps a click on a wide character's trailing cell to its grapheme start", () => {
		const editor = focusedEditor();
		editor.setText("a😀b");
		const rows = plainRows(editor);
		const emoji = locate(rows, "😀");

		click(editor, emoji.line, emoji.col + 1);
		editor.handleInput("X");
		expect(editor.getText()).toBe("aX😀b");
	});

	it("ignores clicks on the border chrome", () => {
		const editor = focusedEditor();
		editor.setText("first\nsecond");
		const rows = plainRows(editor);
		const first = locate(rows, "first");
		const before = editor.getCursor();

		click(editor, 0, first.col); // top border row
		click(editor, first.line, 0); // left border glyph
		click(editor, first.line, WIDTH - 1); // right border glyph
		expect(editor.getCursor()).toEqual(before);
	});

	it("never places the cursor inside an atomic placeholder", () => {
		const editor = focusedEditor();
		editor.atomicTokenPattern = /\[Paste #\d+\]/g;
		editor.setText("go [Paste #1] on");
		const rows = plainRows(editor);
		const token = locate(rows, "[Paste #1]");

		click(editor, token.line, token.col + 2);
		expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
		click(editor, token.line, token.col + 8);
		expect(editor.getCursor()).toEqual({ line: 0, col: 13 });
	});

	it("types at a clicked line start in a recalled history entry", () => {
		const editor = focusedEditor();
		editor.addToHistory("recalled prompt");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("recalled prompt");
		const rows = plainRows(editor);
		const start = locate(rows, "recalled");

		click(editor, start.line, start.col);
		editor.handleInput("X");
		expect(editor.getText()).toBe("Xrecalled prompt");
	});

	it("rests on the last character when clicking past the end in Vim Normal mode", () => {
		const editor = focusedEditor();
		editor.setVimMode(true);
		editor.setText("abc\nlonger");
		editor.handleInput("\x1b");
		const rows = plainRows(editor);

		click(editor, locate(rows, "abc").line, WIDTH - 4);
		expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
	});

	it("extends a Visual selection to the click and reports the new line count", () => {
		const editor = focusedEditor();
		editor.setVimMode(true);
		editor.setText("zero\none\ntwo");
		editor.handleInput("\x1b");
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("V");
		expect(editor.vimSelectedLines).toBe(1);
		const reported: number[] = [];
		editor.onVimModeChange = () => reported.push(editor.vimSelectedLines);
		const rows = plainRows(editor);

		const two = locate(rows, "two");
		click(editor, two.line, two.col);
		expect(editor.vimSelectedLines).toBe(3);
		expect(reported).toEqual([3]);
	});

	it("ignores clicks once focus has moved to another component", () => {
		const editor = focusedEditor();
		editor.setText("alpha beta");
		const rows = plainRows(editor);
		const beta = locate(rows, "beta");

		// Focus leaves between frames: the recorded geometry must not act for a hidden draft.
		editor.focused = false;
		click(editor, beta.line, beta.col);
		expect(editor.getCursor()).toEqual({ line: 0, col: 10 });
	});
});
