/** Greeting for the desktop header (boundaries: before 12:00 / 18:00). */
export function greetingFor(date: Date, firstName: string): string {
  const h = date.getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${part}, ${firstName}`;
}

export function formatDesktopDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
