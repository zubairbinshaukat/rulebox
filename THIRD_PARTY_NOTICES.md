# Third-Party Notices

Rulebox is licensed under the MIT License. It bundles the following
third-party assets and libraries, which keep their own licenses.

| Component | Author | License | Notes |
|---|---|---|---|
| [Solar Icons](https://icon-sets.iconify.design/solar/) | 480 Design | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Icons used in the Staff App and dashboard; bundled via Iconify data. Some icons may be recolored or resized. |
| [GSAP](https://gsap.com) (+ Flip plugin) | GreenSock / Webflow | [GSAP Standard "No Charge" License](https://gsap.com/standard-license/) | Animation library. Free for commercial use; not an open-source license. |
| [Figtree](https://github.com/erikdkennedy/figtree) | Erik Kennedy | [SIL Open Font License 1.1](https://openfontlicense.org) | Bundled UI font. |
| [Geist Mono](https://vercel.com/font) | Vercel | [SIL Open Font License 1.1](https://openfontlicense.org) | Bundled monospace font. |
| [TanStack Virtual](https://tanstack.com/virtual) | Tanner Linsley | [MIT](https://github.com/TanStack/virtual/blob/main/LICENSE) | Windowed lists in the Files app (Staff App). |
| [PDF.js](https://mozilla.github.io/pdf.js/) (pdfjs-dist) | Mozilla and contributors | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | PDF viewer (legacy build, own canvas viewer). Its character maps, standard fonts and decoders are copied into the app at build time. |
| [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | Volodymyr Baydalka | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | Word (.docx) viewer. |
| [SheetJS Community Edition](https://sheetjs.com) (xlsx 0.20.3) | SheetJS LLC | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | Spreadsheet (.xlsx) viewer. Vendored as vendor/xlsx-0.20.3.tgz (SHA-256 8DC73FC3B00203E72D176E85B50938627C7B086E607C682E8D3C22C02BB99FE8). |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Cure53 and contributors | [MPL-2.0 or Apache-2.0](https://github.com/cure53/DOMPurify/blob/main/LICENSE) | Cleans the Word viewer's output before it is shown. |

Keep this file up to date whenever a bundled asset or library with
attribution or non-MIT terms is added.
