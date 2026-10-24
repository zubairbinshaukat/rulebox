import type { ComponentType, SVGProps } from "react";
import type { AppEntry } from "@rulebox/types";
import IconBag from "~icons/solar/bag-4-bold-duotone";
import IconCalculator from "~icons/solar/calculator-bold-duotone";
import IconCalendar from "~icons/solar/calendar-bold-duotone";
import IconCamera from "~icons/solar/camera-bold-duotone";
import IconCard from "~icons/solar/card-bold-duotone";
import IconChart from "~icons/solar/chart-2-bold-duotone";
import IconChat from "~icons/solar/chat-round-dots-bold-duotone";
import IconDelivery from "~icons/solar/delivery-bold-duotone";
import IconDocument from "~icons/solar/document-text-bold-duotone";
import IconFolder from "~icons/solar/folder-with-files-bold-duotone";
import IconGlobal from "~icons/solar/global-bold-duotone";
import IconLearn from "~icons/solar/square-academic-cap-bold-duotone";
import IconLetter from "~icons/solar/letter-bold-duotone";
import IconMusic from "~icons/solar/music-note-2-bold-duotone";
import IconPeople from "~icons/solar/users-group-rounded-bold-duotone";
import IconPhone from "~icons/solar/phone-bold-duotone";
import IconSettings from "~icons/solar/settings-bold-duotone";
import IconTicket from "~icons/solar/ticket-bold-duotone";
import IconUserId from "~icons/solar/user-id-bold-duotone";
import IconVideo from "~icons/solar/clapperboard-play-bold-duotone";
import IconWidget from "~icons/solar/widget-4-bold-duotone";

import { glyphFor, type GlyphKey } from "./appArt";

const GLYPHS: Record<GlyphKey, ComponentType<SVGProps<SVGSVGElement>>> = {
  folder: IconFolder,
  document: IconDocument,
  mail: IconLetter,
  calendar: IconCalendar,
  video: IconVideo,
  music: IconMusic,
  bag: IconBag,
  card: IconCard,
  badge: IconUserId,
  chart: IconChart,
  chat: IconChat,
  people: IconPeople,
  delivery: IconDelivery,
  phone: IconPhone,
  camera: IconCamera,
  calculator: IconCalculator,
  ticket: IconTicket,
  learn: IconLearn,
  settings: IconSettings,
  globe: IconGlobal,
  widget: IconWidget,
};

/** The Solar glyph standing in for a catalogue app (tiles, taskbar, Start). */
export function AppIcon({ app }: { app: AppEntry }) {
  const Glyph = GLYPHS[glyphFor(app)];
  return <Glyph width="1em" height="1em" />;
}

/** Fallback glyph for a program window whose icon could not be loaded. */
export function GenericProgramIcon() {
  return <IconWidget width="1em" height="1em" />;
}
