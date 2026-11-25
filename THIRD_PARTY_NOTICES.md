# Third-Party Notices

Rulebox is licensed under the MIT License. It bundles the following
third-party assets and libraries, which keep their own licenses.

| Component | Author | License | Notes |
|---|---|---|---|
| [Solar Icons](https://icon-sets.iconify.design/solar/) | 480 Design | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Icons used in the Staff App and dashboard; bundled via Iconify data. Some icons may be recolored or resized. |
| [GSAP](https://gsap.com) (+ Flip plugin) | GreenSock / Webflow | [GSAP Standard "No Charge" License](https://gsap.com/standard-license/) | Animation library. Free for commercial use; not an open-source license. |
| [Figtree](https://github.com/erikdkennedy/figtree) | Erik Kennedy | [SIL Open Font License 1.1](https://openfontlicense.org) | Bundled UI font. |
| [Geist Mono](https://vercel.com/font) | Vercel | [SIL Open Font License 1.1](https://openfontlicense.org) | Bundled monospace font. |
| [Source Serif 4](https://github.com/adobe-fonts/source-serif) | Frank Grießhammer, Adobe | [SIL Open Font License 1.1](https://github.com/adobe-fonts/source-serif/blob/release/LICENSE.md) | Website heading font, self-hosted from `@fontsource-variable/source-serif-4` (Latin and Latin Extended subsets). |
| [Instrument Sans](https://github.com/Instrument/instrument-sans) | Instrument | [SIL Open Font License 1.1](https://github.com/Instrument/instrument-sans/blob/main/OFL.txt) | Website text font, self-hosted from `@fontsource-variable/instrument-sans` (Latin and Latin Extended subsets). |
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

## Website photos

The public website's home hero (`apps/website/src/assets/home/`) and
use-case pages (`apps/website/src/assets/use-cases/`)
bundle these stock photos from [Pexels](https://www.pexels.com), used under
the [Pexels License](https://www.pexels.com/license/) (free for commercial
use, attribution not required; credited anyway, here and on the site at
`/legal/licenses` and at the foot of each use-case page). The licence was
checked on each photo's page on 2026-11-24. The people and places shown are
not Rulebox customers and do not endorse Rulebox. The files were downloaded
once (about 1800-2400 px wide) and are served from the site, never hotlinked.

| File | Photo | Photographer |
|---|---|---|
| `home/hero-pos.jpg` (licence checked 2026-11-25; two small brand marks softened in our copy) | [Restaurant Worker Making Order with Use of Touchscreen](https://www.pexels.com/photo/restaurant-worker-making-order-with-use-of-touchscreen-12935100/) | [iMin Technology](https://www.pexels.com/@imin-technology-276315592/) |
| `shared-staff-pcs-hero.jpg` | [People Working in front of the Computer](https://www.pexels.com/photo/people-working-in-front-of-the-computer-3184357/) | [fauxels](https://www.pexels.com/@fauxels/) |
| `shared-staff-pcs-office.jpg` (licence checked 2026-11-25) | [Employees Sitting on Swivel Chairs while Looking at the Monitor](https://www.pexels.com/photo/employees-sitting-on-swivel-chairs-while-looking-at-the-monitor-7988750/) | [Mikhail Nilov](https://www.pexels.com/@mikhail-nilov/) |
| `retail-pos-hero.jpg` (licence checked 2026-11-25; the small maker logo on the till screen softened in our copy) | [A Close-Up Shot of a Cashier Using a Point of Sale System](https://www.pexels.com/photo/a-close-up-shot-of-a-cashier-using-a-point-of-sale-system-12935074/) | [iMin Technology](https://www.pexels.com/@imin-technology-276315592/) |
| `retail-pos-till.jpg` (licence checked 2026-11-25; small product and brand marks softened and the frame cropped in our copy) | [Cashier in Store](https://www.pexels.com/photo/cashier-in-store-3735172/) | [Polina Tankilevitch](https://www.pexels.com/@polina-tankilevitch/) |
| `retail-pos-boutique.jpg` | [A Woman Shopping in a Boutique](https://www.pexels.com/photo/a-woman-shopping-in-a-boutique-7679468/) | [MART PRODUCTION](https://www.pexels.com/@mart-production/) |
| `schools-hero.jpg` | [Students Using Computers](https://www.pexels.com/photo/students-using-computers-10638069/) | [Ron Lach](https://www.pexels.com/@ron-lach/) |
| `schools-class.jpg` | [Students Using Computers in Their Class](https://www.pexels.com/photo/students-using-computers-in-their-class-10638075/) | [Ron Lach](https://www.pexels.com/@ron-lach/) |
| `schools-pair.jpg` | [Kids in a Computer Lab](https://www.pexels.com/photo/kids-in-a-computer-lab-5621945/) | [Gustavo Fring](https://www.pexels.com/@gustavo-fring/) |
| `clinics-hero.jpg` (licence checked 2026-11-25) | [Side View of a Man Wearing Face Mask while Typing on Computer Keyboard](https://www.pexels.com/photo/side-view-of-a-man-wearing-face-mask-while-typing-on-computer-keyboard-4269490/) | [Cedric Fauntleroy](https://www.pexels.com/@cedric-fauntleroy/) |
| `clinics-pharmacist.jpg` (licence checked 2026-11-25; the pharmacy chain logo, name badge and one product box softened in our copy) | [Pharmacist at Counter](https://www.pexels.com/photo/pharmacist-at-counter-14797864/) | [World Sikh Organization of Canada](https://www.pexels.com/@worldsikhorg/) |
| `clinics-pharmacy.jpg` | [Man and Woman Working Together in a Pharmacy](https://www.pexels.com/photo/man-and-woman-working-together-in-a-pharmacy-8657290/) | [cottonbro studio](https://www.pexels.com/@cottonbro/) |
| `call-centres-hero.jpg` (licence checked 2026-11-25) | [Man in Blue Sweater Using Headphones](https://www.pexels.com/photo/man-in-blue-sweater-using-headphones-8867244/) | [Yan Krukau](https://www.pexels.com/@yankrukov/) |
| `call-centres-agent.jpg` (licence checked 2026-11-25) | [Man in Blue Polo Shirt with Headset Using Black Computer](https://www.pexels.com/photo/man-in-blue-polo-shirt-with-headset-using-black-computer-8204318/) | [Kampus Production](https://www.pexels.com/@kampus/) |
| `call-centres-pair.jpg` | [Man and Woman Wearing a Headset with a Microphone in an Office](https://www.pexels.com/photo/man-and-woman-wearing-a-headset-with-a-microphone-in-an-office-8192185/) | [Antoni Shkraba](https://www.pexels.com/@shkrabaanthony/) |
| `hotels-hero.jpg` (licence checked 2026-11-25) | [Chic Miami Beach Hotel Reception Interior](https://www.pexels.com/photo/chic-miami-beach-hotel-reception-interior-34607320/) | [Abhishek Navlakha](https://www.pexels.com/@navlakha/) |
| `hotels-desk.jpg` (licence checked 2026-11-25) | [Modern Hotel Lounge](https://www.pexels.com/photo/modern-hotel-lounge-20382216/) | [Trần Chính](https://www.pexels.com/@tr-n-chinh-587690133/) |
| `hotels-sign.jpg` (licence checked 2026-11-25) | [Selective Focus Photo of Reception Signage](https://www.pexels.com/photo/selective-focus-photo-of-reception-signage-3768095/) | [Andrea Piacquadio](https://www.pexels.com/@olly/) |

Keep this file up to date whenever a bundled asset or library with
attribution or non-MIT terms is added.
