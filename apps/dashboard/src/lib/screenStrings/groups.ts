import { n } from "../strings";

export const groupsStrings = {
  title: "Groups",
  lead: "Groups decide which apps and employees each PC gets.",
  add: "New group",
  addTitle: "New group",
  name: "Name",
  description: "Description",
  colName: "Group",
  colDevices: "Devices",
  colEmployees: "Employees",
  colCreated: "Created",
  /** The cards' sort choices: "Name: A to Z". */
  colNameSort: "Name",
  /** The label of the device count on a card. */
  cardPcs: "PCs",
  searchLabel: "Search groups",
  searchPlaceholder: "Search by name or description",
  emptyTitle: "No groups yet",
  emptyBody: "Create a group, then add PCs and employees to it.",
  devices: (count: number) => n(count, "device", "devices", 500),
  employees: (count: number) => n(count, "employee", "employees", 500),
  created: (name: string) => `Group “${name}” created.`,
} as const;
