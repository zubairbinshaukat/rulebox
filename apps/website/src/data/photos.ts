/*
 * Stock photography for the use-case pages. Every photo is from Pexels
 * (Pexels License: free for commercial use, attribution not required,
 * no implied endorsement). We credit each one anyway: on the page, on
 * /legal/licenses and in THIRD_PARTY_NOTICES.md.
 *
 * Honesty (Story §1): these are stock photos of real workplaces, not
 * Rulebox customers. Alt text describes the scene only. Never caption a
 * photo as a customer or as a place that uses Rulebox.
 *
 * Source files live in src/assets/use-cases/ (downloaded once, bundled;
 * offline-first, never hotlinked). astro:assets makes AVIF/WebP at build.
 */
import type { ImageMetadata } from "astro";

import sharedHero from "../assets/use-cases/shared-staff-pcs-hero.jpg";
import sharedOffice from "../assets/use-cases/shared-staff-pcs-office.jpg";
import retailHero from "../assets/use-cases/retail-pos-hero.jpg";
import retailTill from "../assets/use-cases/retail-pos-till.jpg";
import retailBoutique from "../assets/use-cases/retail-pos-boutique.jpg";
import schoolsHero from "../assets/use-cases/schools-hero.jpg";
import schoolsClass from "../assets/use-cases/schools-class.jpg";
import schoolsPair from "../assets/use-cases/schools-pair.jpg";
import clinicsHero from "../assets/use-cases/clinics-hero.jpg";
import clinicsPharmacist from "../assets/use-cases/clinics-pharmacist.jpg";
import clinicsPharmacy from "../assets/use-cases/clinics-pharmacy.jpg";
import callHero from "../assets/use-cases/call-centres-hero.jpg";
import callAgent from "../assets/use-cases/call-centres-agent.jpg";
import callPair from "../assets/use-cases/call-centres-pair.jpg";
import hotelsHero from "../assets/use-cases/hotels-hero.jpg";
import hotelsDesk from "../assets/use-cases/hotels-desk.jpg";
import hotelsSign from "../assets/use-cases/hotels-sign.jpg";
import homeHero from "../assets/home/hero-pos.jpg";

export interface Photo {
  src: ImageMetadata;
  alt: string;
  /** Focal point for object-position, so crops keep the person in frame. */
  focus?: string;
  photographer: string;
  photographerUrl: string;
  title: string;
  pageUrl: string;
}

const PEXELS = "Pexels";
export const PHOTO_SOURCE = PEXELS;
export const PHOTO_LICENSE = { name: "Pexels License", url: "https://www.pexels.com/license/" };

export const PHOTOS = {
  /* Home hero backdrop. Two small brand marks (on the till stand and the
     cap) were softened in our copy, as the Pexels License allows. */
  homeHero: {
    src: homeHero,
    alt: "A café worker taps an order into a touchscreen till on the counter.",
    focus: "50% 40%",
    photographer: "iMin Technology",
    photographerUrl: "https://www.pexels.com/@imin-technology-276315592/",
    title: "Restaurant Worker Making Order with Use of Touchscreen",
    pageUrl: "https://www.pexels.com/photo/restaurant-worker-making-order-with-use-of-touchscreen-12935100/",
  },
  sharedHero: {
    src: sharedHero,
    alt: "Colleagues working side by side at shared desktop computers in a bright open office.",
    focus: "50% 45%",
    photographer: "fauxels",
    photographerUrl: "https://www.pexels.com/@fauxels/",
    title: "People Working in front of the Computer",
    pageUrl: "https://www.pexels.com/photo/people-working-in-front-of-the-computer-3184357/",
  },
  sharedOffice: {
    src: sharedOffice,
    alt: "Two colleagues work together at a shared desktop computer in a bright office.",
    focus: "52% 35%",
    photographer: "Mikhail Nilov",
    photographerUrl: "https://www.pexels.com/@mikhail-nilov/",
    title: "Employees Sitting on Swivel Chairs while Looking at the Monitor",
    pageUrl: "https://www.pexels.com/photo/employees-sitting-on-swivel-chairs-while-looking-at-the-monitor-7988750/",
  },
  /* The maker's small logo on the till screen was softened in our copy. */
  retailHero: {
    src: retailHero,
    alt: "Close-up of a hand tapping an order on a touchscreen till at a shop counter.",
    focus: "60% 40%",
    photographer: "iMin Technology",
    photographerUrl: "https://www.pexels.com/@imin-technology-276315592/",
    title: "A Close-Up Shot of a Cashier Using a Point of Sale System",
    pageUrl: "https://www.pexels.com/photo/a-close-up-shot-of-a-cashier-using-a-point-of-sale-system-12935074/",
  },
  /* Small product and brand marks (a gum box, the scale maker's badge, the
     shop name on the till screen) were softened, and the frame cropped
     closer to the counter, in our copy. */
  retailTill: {
    src: retailTill,
    alt: "A shop worker in an apron at the counter, beside the till screen, scale and card reader.",
    focus: "47% 40%",
    photographer: "Polina Tankilevitch",
    photographerUrl: "https://www.pexels.com/@polina-tankilevitch/",
    title: "Cashier in Store",
    pageUrl: "https://www.pexels.com/photo/cashier-in-store-3735172/",
  },
  retailBoutique: {
    src: retailBoutique,
    alt: "A clothing shop counter: an assistant with a laptop talks with a customer holding a shirt.",
    focus: "55% 45%",
    photographer: "MART PRODUCTION",
    photographerUrl: "https://www.pexels.com/@mart-production/",
    title: "A Woman Shopping in a Boutique",
    pageUrl: "https://www.pexels.com/photo/a-woman-shopping-in-a-boutique-7679468/",
  },
  schoolsHero: {
    src: schoolsHero,
    alt: "A school computer lab: rows of pupils with headphones working at desktop PCs.",
    focus: "50% 50%",
    photographer: "Ron Lach",
    photographerUrl: "https://www.pexels.com/@ron-lach/",
    title: "Students Using Computers",
    pageUrl: "https://www.pexels.com/photo/students-using-computers-10638069/",
  },
  schoolsClass: {
    src: schoolsClass,
    alt: "Pupils in school uniform sit at lab computers during a class, seen from behind.",
    focus: "50% 50%",
    photographer: "Ron Lach",
    photographerUrl: "https://www.pexels.com/@ron-lach/",
    title: "Students Using Computers in Their Class",
    pageUrl: "https://www.pexels.com/photo/students-using-computers-in-their-class-10638075/",
  },
  schoolsPair: {
    src: schoolsPair,
    alt: "Two children share a desktop computer in a classroom, one pointing at the keyboard.",
    focus: "60% 50%",
    photographer: "Gustavo Fring",
    photographerUrl: "https://www.pexels.com/@gustavo-fring/",
    title: "Kids in a Computer Lab",
    pageUrl: "https://www.pexels.com/photo/kids-in-a-computer-lab-5621945/",
  },
  clinicsHero: {
    src: clinicsHero,
    alt: "A clinic staff member in scrubs types at the desktop computer on his desk in a bright clinic.",
    focus: "70% 0%",
    photographer: "Cedric Fauntleroy",
    photographerUrl: "https://www.pexels.com/@cedric-fauntleroy/",
    title: "Side View of a Man Wearing Face Mask while Typing on Computer Keyboard",
    pageUrl: "https://www.pexels.com/photo/side-view-of-a-man-wearing-face-mask-while-typing-on-computer-keyboard-4269490/",
  },
  /* The pharmacy chain's logo and name badge on the coat, and one product
     box, were softened in our copy. */
  clinicsPharmacist: {
    src: clinicsPharmacist,
    alt: "A pharmacist in a white coat works at the counter computer in front of shelves of medicines.",
    focus: "58% 30%",
    photographer: "World Sikh Organization of Canada",
    photographerUrl: "https://www.pexels.com/@worldsikhorg/",
    title: "Pharmacist at Counter",
    pageUrl: "https://www.pexels.com/photo/pharmacist-at-counter-14797864/",
  },
  clinicsPharmacy: {
    src: clinicsPharmacy,
    alt: "Two pharmacists in white coats work at a laptop on the dispensary counter.",
    focus: "55% 40%",
    photographer: "cottonbro studio",
    photographerUrl: "https://www.pexels.com/@cottonbro/",
    title: "Man and Woman Working Together in a Pharmacy",
    pageUrl: "https://www.pexels.com/photo/man-and-woman-working-together-in-a-pharmacy-8657290/",
  },
  callHero: {
    src: callHero,
    alt: "A smiling call centre agent in a headset at his desk, with colleagues at a row of desktop PCs behind him.",
    focus: "60% 36%",
    photographer: "Yan Krukau",
    photographerUrl: "https://www.pexels.com/@yankrukov/",
    title: "Man in Blue Sweater Using Headphones",
    pageUrl: "https://www.pexels.com/photo/man-in-blue-sweater-using-headphones-8867244/",
  },
  callAgent: {
    src: callAgent,
    alt: "A call centre agent in a headset types at his desktop computer.",
    focus: "62% 32%",
    photographer: "Kampus Production",
    photographerUrl: "https://www.pexels.com/@kampus/",
    title: "Man in Blue Polo Shirt with Headset Using Black Computer",
    pageUrl: "https://www.pexels.com/photo/man-in-blue-polo-shirt-with-headset-using-black-computer-8204318/",
  },
  callPair: {
    src: callPair,
    alt: "Two agents wearing headsets with microphones work side by side at desktop computers.",
    focus: "35% 50%",
    photographer: "Antoni Shkraba",
    photographerUrl: "https://www.pexels.com/@shkrabaanthony/",
    title: "Man and Woman Wearing a Headset with a Microphone in an Office",
    pageUrl: "https://www.pexels.com/photo/man-and-woman-wearing-a-headset-with-a-microphone-in-an-office-8192185/",
  },
  hotelsHero: {
    src: hotelsHero,
    alt: "A bright boutique hotel reception: a patterned marble front desk under pendant lamps.",
    focus: "60% 55%",
    photographer: "Abhishek Navlakha",
    photographerUrl: "https://www.pexels.com/@navlakha/",
    title: "Chic Miami Beach Hotel Reception Interior",
    pageUrl: "https://www.pexels.com/photo/chic-miami-beach-hotel-reception-interior-34607320/",
  },
  hotelsDesk: {
    src: hotelsDesk,
    alt: "A modern hotel lobby with a dark marble front desk and a lounge of armchairs.",
    focus: "40% 60%",
    photographer: "Trần Chính",
    photographerUrl: "https://www.pexels.com/@tr-n-chinh-587690133/",
    title: "Modern Hotel Lounge",
    pageUrl: "https://www.pexels.com/photo/modern-hotel-lounge-20382216/",
  },
  hotelsSign: {
    src: hotelsSign,
    alt: "A brass reception sign and a service bell on a wooden hotel front desk.",
    focus: "55% 55%",
    photographer: "Andrea Piacquadio",
    photographerUrl: "https://www.pexels.com/@olly/",
    title: "Selective Focus Photo of Reception Signage",
    pageUrl: "https://www.pexels.com/photo/selective-focus-photo-of-reception-signage-3768095/",
  },
} satisfies Record<string, Photo>;

export type PhotoKey = keyof typeof PHOTOS;

/** Photos per use-case page: the hero, one beside the problem, one beside the outcome. */
export const USE_CASE_PHOTOS: Record<string, { hero: Photo; scene?: Photo; outcome?: Photo }> = {
  "shared-staff-pcs": { hero: PHOTOS.sharedHero, scene: PHOTOS.sharedOffice },
  "retail-pos": { hero: PHOTOS.retailHero, scene: PHOTOS.retailTill, outcome: PHOTOS.retailBoutique },
  "schools-and-computer-labs": { hero: PHOTOS.schoolsHero, scene: PHOTOS.schoolsPair, outcome: PHOTOS.schoolsClass },
  "clinics-and-pharmacies": { hero: PHOTOS.clinicsHero, scene: PHOTOS.clinicsPharmacist, outcome: PHOTOS.clinicsPharmacy },
  "call-centres": { hero: PHOTOS.callHero, scene: PHOTOS.callPair, outcome: PHOTOS.callAgent },
  "hotels-front-desk": { hero: PHOTOS.hotelsHero, scene: PHOTOS.hotelsSign, outcome: PHOTOS.hotelsDesk },
};

/** Every photo on a page, in page order, for its small credits line. */
export function photosFor(slug: string): Photo[] {
  const p = USE_CASE_PHOTOS[slug];
  if (!p) return [];
  return [p.hero, p.scene, p.outcome].filter((x): x is Photo => !!x);
}

export const ALL_PHOTOS: Photo[] = Object.values(PHOTOS);
