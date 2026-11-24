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
import clinicsReception from "../assets/use-cases/clinics-reception.jpg";
import clinicsPharmacy from "../assets/use-cases/clinics-pharmacy.jpg";
import callHero from "../assets/use-cases/call-centres-hero.jpg";
import callFloor from "../assets/use-cases/call-centres-floor.jpg";
import callPair from "../assets/use-cases/call-centres-pair.jpg";
import hotelsHero from "../assets/use-cases/hotels-hero.jpg";
import hotelsDesk from "../assets/use-cases/hotels-desk.jpg";
import hotelsCard from "../assets/use-cases/hotels-card.jpg";
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
    alt: "Staff at computer desks in an office, a colleague leaning in to help at one screen.",
    focus: "45% 50%",
    photographer: "Pavel Danilyuk",
    photographerUrl: "https://www.pexels.com/@pavel-danilyuk/",
    title: "People Working in front of their Computer Desks",
    pageUrl: "https://www.pexels.com/photo/people-working-in-front-of-their-computer-desks-7658400/",
  },
  retailHero: {
    src: retailHero,
    alt: "A smiling cashier taps the touchscreen till at the counter of a small shop.",
    focus: "52% 45%",
    photographer: "Ketut Subiyanto",
    photographerUrl: "https://www.pexels.com/@ketut-subiyanto/",
    title: "Exited ethnic waitress working with cash desk in cozy cafeteria",
    pageUrl: "https://www.pexels.com/photo/exited-ethnic-waitress-working-with-cash-desk-in-cozy-cafeteria-4473496/",
  },
  retailTill: {
    src: retailTill,
    alt: "A shop worker in an apron uses the screen of a till terminal by the window.",
    focus: "55% 40%",
    photographer: "Andrea Piacquadio",
    photographerUrl: "https://www.pexels.com/@olly/",
    title: "Woman Working as a Cashier",
    pageUrl: "https://www.pexels.com/photo/woman-working-as-a-cashier-3801439/",
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
    alt: "A bright clinic reception: patients register at the front desk while staff work at their screens.",
    focus: "45% 55%",
    photographer: "Pavel Danilyuk",
    photographerUrl: "https://www.pexels.com/@pavel-danilyuk/",
    title: "Couple During Registration in Clinic",
    pageUrl: "https://www.pexels.com/photo/couple-during-registration-in-clinic-7108318/",
  },
  clinicsReception: {
    src: clinicsReception,
    alt: "A receptionist in scrubs, holding a tablet, smiles at a patient across a clinic front desk.",
    focus: "40% 62%",
    photographer: "Cedric Fauntleroy",
    photographerUrl: "https://www.pexels.com/@cedric-fauntleroy/",
    title: "A Receptionist Smiling at a Person",
    pageUrl: "https://www.pexels.com/photo/a-receptionist-smiling-at-a-person-4269203/",
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
    alt: "Call centre agents with headsets on a call at their desktop PCs by a bright window.",
    focus: "40% 45%",
    photographer: "Yan Krukau",
    photographerUrl: "https://www.pexels.com/@yankrukov/",
    title: "Call Center Agent Working",
    pageUrl: "https://www.pexels.com/photo/call-center-agent-working-8867267/",
  },
  callFloor: {
    src: callFloor,
    alt: "An office floor of agents in headsets working at laptops on separate desks.",
    focus: "50% 55%",
    photographer: "MART PRODUCTION",
    photographerUrl: "https://www.pexels.com/@mart-production/",
    title: "People Working in Call Center",
    pageUrl: "https://www.pexels.com/photo/people-working-in-call-center-7709240/",
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
    alt: "A hotel receptionist in a dark suit types at the front-desk computer in the lobby.",
    focus: "35% 45%",
    photographer: "iram shehzad",
    photographerUrl: "https://www.pexels.com/@iram-shehzad-45081404/",
    title: "Professional Receptionist at Work in Islamabad Hotel",
    pageUrl: "https://www.pexels.com/photo/professional-receptionist-at-work-in-islamabad-hotel-36817019/",
  },
  hotelsDesk: {
    src: hotelsDesk,
    alt: "A receptionist at a computer greets a guest across a long front desk with several workstations.",
    focus: "45% 55%",
    photographer: "FAKHRUL HASSAN",
    photographerUrl: "https://www.pexels.com/@fakhrul-hassan-78162644/",
    title: "Friendly Hotel Reception Interaction in Dhaka",
    pageUrl: "https://www.pexels.com/photo/friendly-hotel-reception-interaction-in-dhaka-37680832/",
  },
  hotelsCard: {
    src: hotelsCard,
    alt: "Close-up of a guest handing a card to a receptionist across a hotel desk.",
    focus: "50% 45%",
    photographer: "Mikhail Nilov",
    photographerUrl: "https://www.pexels.com/@mikhail-nilov/",
    title: "Man Handing a Credit Card to a Hotel Receptionist",
    pageUrl: "https://www.pexels.com/photo/man-handing-a-credit-card-to-a-hotel-receptionist-7820359/",
  },
} satisfies Record<string, Photo>;

export type PhotoKey = keyof typeof PHOTOS;

/** Photos per use-case page: the hero, one beside the problem, one beside the outcome. */
export const USE_CASE_PHOTOS: Record<string, { hero: Photo; scene?: Photo; outcome?: Photo }> = {
  "shared-staff-pcs": { hero: PHOTOS.sharedHero, scene: PHOTOS.sharedOffice },
  "retail-pos": { hero: PHOTOS.retailHero, scene: PHOTOS.retailTill, outcome: PHOTOS.retailBoutique },
  "schools-and-computer-labs": { hero: PHOTOS.schoolsHero, scene: PHOTOS.schoolsPair, outcome: PHOTOS.schoolsClass },
  "clinics-and-pharmacies": { hero: PHOTOS.clinicsHero, scene: PHOTOS.clinicsReception, outcome: PHOTOS.clinicsPharmacy },
  "call-centres": { hero: PHOTOS.callHero, scene: PHOTOS.callPair, outcome: PHOTOS.callFloor },
  "hotels-front-desk": { hero: PHOTOS.hotelsHero, scene: PHOTOS.hotelsCard, outcome: PHOTOS.hotelsDesk },
};

/** Every photo on a page, in page order, for its small credits line. */
export function photosFor(slug: string): Photo[] {
  const p = USE_CASE_PHOTOS[slug];
  if (!p) return [];
  return [p.hero, p.scene, p.outcome].filter((x): x is Photo => !!x);
}

export const ALL_PHOTOS: Photo[] = Object.values(PHOTOS);
