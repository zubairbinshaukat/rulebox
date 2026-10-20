/** Above this many lines the text is shown in a window of rows, not as one block. */
export const WINDOWED_ABOVE_LINES = 5000;
export const TEXT_LINE_HEIGHT = 20;

/** The lines of a text, whatever line ending it uses. An empty text has none. */
export function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/\r\n|\r|\n/);
}
