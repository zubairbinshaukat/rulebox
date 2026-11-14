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
| [Convex](https://www.convex.dev) (`convex`) | Convex, Inc. | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | Backend platform client and server libraries (backend, dashboard). |
| [Convex Auth](https://labs.convex.dev/auth) (`@convex-dev/auth`) | Convex, Inc. | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | Member sign-in (backend and dashboard). |
| [convex-helpers](https://github.com/get-convex/convex-helpers) | Convex, Inc. | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | Custom function wrappers (backend). |
| [Convex Rate Limiter](https://github.com/get-convex/rate-limiter) (`@convex-dev/rate-limiter`) | Convex, Inc. | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | Rate limits on sign-in, enrollment and PIN attempts (backend). |
| [@noble/ed25519](https://github.com/paulmillr/noble-ed25519) | Paul Miller | [MIT](https://github.com/paulmillr/noble-ed25519/blob/main/LICENSE) | Signs policy documents (backend). |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | Paul Miller | [MIT](https://github.com/paulmillr/noble-hashes/blob/main/LICENSE) | SHA-256, SHA-512 and HMAC (backend). |
| [hash-wasm](https://github.com/Daninet/hash-wasm) | Dani Biro | [MIT](https://github.com/Daninet/hash-wasm/blob/master/LICENSE) | Argon2id for PINs and passwords (backend). |
| [@simplewebauthn/server and browser](https://simplewebauthn.dev) | Matthew Miller | [MIT](https://github.com/MasterKale/SimpleWebAuthn/blob/master/LICENSE.md) | Passkeys for step-up confirmation (backend, dashboard). |
| [Auth.js core](https://authjs.dev) (`@auth/core`) | Balazs Orban and contributors | [ISC](https://github.com/nextauthjs/next-auth/blob/main/LICENSE) | Used by Convex Auth for the password provider (backend). |
| [Lucia](https://lucia-auth.com) (`lucia`) | pilcrowOnPaper | [MIT](https://github.com/lucia-auth/lucia/blob/main/LICENSE) | Scrypt password hashing (backend). |
| [yaml](https://eemeli.org/yaml/) | Eemeli Aro | [ISC](https://github.com/eemeli/yaml/blob/main/LICENSE) | Reads winget manifests (backend). |
| [React Router](https://reactrouter.com) (`react-router`) | Remix Software | [MIT](https://github.com/remix-run/react-router/blob/main/LICENSE.md) | Dashboard routing. |
| [ed25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek) | isis lovecruft, Henry de Valence and contributors | [BSD-3-Clause](https://github.com/dalek-cryptography/curve25519-dalek/blob/main/ed25519-dalek/LICENSE) | Verifies signed policies (agent, `rulebox-policy` crate). |
| [reqwest](https://github.com/seanmonstar/reqwest) | Sean McArthur | [MIT or Apache-2.0](https://github.com/seanmonstar/reqwest#license) | HTTPS downloads of installers (agent). |
| [Microsoft recommended block rules](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/applications-that-can-bypass-appcontrol) (App Control for Business) | Microsoft Corporation | Microsoft Learn content: documentation text CC BY 4.0, code samples MIT (the licences Microsoft publishes for its Learn repositories). **Not re-verified for this page:** the public docs repository was not reachable on 2026-11-08, and the page itself shows only "(c) Microsoft" and the Terms of Use. Confirm before a release. | The policy XML on that page, copied on 2026-11-08 (page date 2026-03-29) into `apps/agent/policies/appcontrol/recommended-blocks.xml`, with only the base-policy header, the policy version and the policy name changed (the file's comment lists them). Compiled into the agent as an App Control base policy. |

Keep this file up to date whenever a bundled asset or library with
attribution or non-MIT terms is added.
