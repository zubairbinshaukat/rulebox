/** The printer form's sentences (new and edit). Only the printer screen imports this file. */
import type { PrinterKind } from "../../data/types";
import { formatNumber, plural } from "../../lib/format";
import type { AddressProblem, NameProblem, PortProblem, QueueProblem } from "../../lib/printerRules";
import { MAX_LPR_QUEUE, MAX_PRINTER_NAME, MAX_TCP_HOST } from "../../lib/printerRules";

export const printerStrings = {
  title: "Printer",
  newTitle: "New printer",
  loading: "Loading printers",
  address: "Printer address",
  addressPlaceholder: "10.0.0.20 or \\\\server\\printer",
  addressInfo: "The printer's IP address or name, a full ipp:// address, or \\\\server\\printer for a printer a server shares. Rulebox works out the rest.",
  /** Typed text that is no printer address at all. */
  addressNone: "Enter an IP address, a name, an ipp:// address or \\\\server\\printer",
  connectsAs: (kind: string) => `Connects as: ${kind}`,
  connectsAsInfo: "Rulebox read your address and picked the way to reach the printer. Change it under Advanced if it guessed wrong.",
  kindNames: {
    ipp: "Network printer (IPP)",
    raw: "Network printer (port)",
    lpr: "Network printer (LPR)",
    share: "Shared by a server",
  } satisfies Record<PrinterKind, string>,
  /** The line under the address: the kind and what it implies. */
  detected: {
    ipp: "Network printer (IPP)",
    raw: (port: number) => `Network printer, port ${port}`,
    lpr: (queue: string) => `Network printer, queue ${queue}`,
    share: "Shared by a server",
  },
  addressProblems: {
    empty: "Enter the printer's address.",
    length: `That address is too long (printers reached by a port or a queue: at most ${MAX_TCP_HOST} characters).`,
    scheme: "Start the address with ipp:// or https://.",
    credentials: "Remove the user name and password from the address.",
    host: "Use an IP address or a name made of letters, digits and hyphens. Leave the port out here.",
    port: "The port in the address must be a number from 1 to 65535.",
    path: "Add the path after the host, usually /ipp/print.",
    share: "Write the shared name as \\\\server\\name.",
    characters: "Remove spaces, commas and special characters that a printer address cannot have.",
  } satisfies Record<AddressProblem, string>,

  name: "Name on the PCs",
  namePlaceholder: "Front desk printer",
  nameInfo: "Shown in the Print window on the PCs as the name followed by (Rulebox).",
  nameProblems: {
    empty: "Enter a name.",
    length: `Use at most ${MAX_PRINTER_NAME} characters.`,
    characters: "Leave out backslashes, commas, slashes and line breaks.",
  } satisfies Record<NameProblem, string>,
  nameTaken: "Another printer already has this name.",

  makeDefault: "Make it the default printer",
  makeDefaultInfo: "The PCs print here first. A group has one default printer.",
  defaultSome: "Only in some of these groups. See Advanced.",
  defaultTaken: "Another printer is already the default for one of these groups. Turn that one off first.",
  defaultsLegend: "Default printer in",
  defaultIn: (group: string) => `Default in ${group}`,

  // ---- Advanced
  connectionType: "Connection type",
  connectionInfo: "Automatic reads the address you typed. Change it only if Rulebox guessed wrong.",
  automatic: "Automatic",
  kindHelp: {
    ipp: "The usual choice for a modern network printer.",
    raw: "Sends the job straight to the printer's port.",
    lpr: "For older printers and print servers. Needs a queue name.",
    share: "A printer a Windows server shares.",
  } satisfies Record<PrinterKind, string>,
  port: "Port",
  portHint: "Leave empty for 9100, the port almost every printer listens on.",
  portProblems: { range: "Use a whole number from 1 to 65535, or leave it empty." } satisfies Record<PortProblem, string>,
  queue: "Queue name",
  queueHint: `The queue the printer expects, at most ${MAX_LPR_QUEUE} characters.`,
  queueProblems: {
    required: "Enter the queue name.",
    length: `A queue name is at most ${MAX_LPR_QUEUE} characters.`,
    characters: "A queue name has no spaces or control characters.",
  } satisfies Record<QueueProblem, string>,
  driver: "Driver",
  driverInfo: "Automatic uses the driver Windows already has. Pick another only if the printer needs its maker's driver on the PCs.",
  driverAuto: "Automatic (built into Windows)",
  driverOther: "Another driver already on the PCs…",
  driverOtherName: "Driver name",
  driverOtherHint: "Exactly as Windows shows it. Rulebox adds it to the approved names when you save.",
  driverDelivered: "Delivered by Rulebox",
  driverNotListed: "Not on the approved list any more",
  driverSearch: "Find a driver",
  driverRefused: "That driver is not on the approved list.",
  driverNoneFound: "No driver matches.",
  driverAddedFailed: "The driver name couldn't be added, so the printer wasn't saved.",

  create: "Add printer",
  saved: "Printer saved.",
  created: (name: string) => `${name} added.`,
  deleted: (name: string) => `${name} removed.`,

  // ---- the aside of a new printer
  examplesTitle: "What you can type",
  examples: [
    { code: "10.0.0.20", text: "The printer's IP address or name" },
    { code: "ipp://printer.local/ipp/print", text: "A full printer address" },
    { code: "\\\\server\\printer", text: "A printer a server shares" },
  ],
  examplesFoot: "Rulebox works out the connection and picks the driver by itself.",

  // ---- delete and counts
  deleteTitle: (name: string) => `Remove ${name}?`,
  deleteBody: "The printer is taken away from every group. The PCs remove the printer they set up for it. This can't be undone.",
  remove: "Remove printer",
  applied: "Set up",
  failed: "Failed",
  defaultBadge: (count: number) => `Default in ${formatNumber(count)} ${plural(count, { one: "group", other: "groups" })}`,

  // ---- read only
  readName: "Name",
  readAddress: "Address",
  readConnection: "Connection",
  readDriver: "Driver",
  readDefault: "Default printer",
};
