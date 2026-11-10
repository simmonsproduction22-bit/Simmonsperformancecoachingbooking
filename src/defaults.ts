// What the site is set up with. The very first coach account (Connor's) is filled in with this
// automatically, so the live site starts out matching the demo. Everything stays editable in Settings.

export const STARTER_PACKAGES: [name: string, description: string, lessons: number, priceCents: number,
  kind: "private" | "group", minPeople: number, maxPeople: number, sortOrder: number, firstTimeOnly?: boolean][] = [
  ["12-Lesson Pack", "Twelve private lessons at $100 each. Best value.", 12, 120000, "private", 1, 1, 10],
  ["8-Lesson Pack", "Eight private lessons at $110 each.", 8, 88000, "private", 1, 1, 20],
  ["Single Lesson", "One private lesson.", 1, 12500, "private", 1, 1, 30],
  ["Intro Lesson", "Your first private lesson at an intro price. New clients only.", 1, 6000, "private", 1, 1, 35, true],
  ["Small Group Lesson", "Bring your crew: one lesson for a group of 3 or more. Price is per person.", 1, 5000, "group", 3, 10, 40],
];

export const FIRST_COACH_SETUP = {
  person_name: "Connor Simmons",
  headline: "The best hour of your day",
  bio: "I've competed in over 200 grappling matches, fought professional Muay Thai in Thailand, and hold a 3-1 MMA record. I'm still competing at 146 lb and coach at Fortis MMA in Dallas.",
  location: "Dallas, TX",
  venues: "Fortis MMA · Iron MMA · In-home training",
  credentials: "200+ grappling matches · Pro Muay Thai in Thailand · 3-1 MMA record · Coach at Fortis MMA",
  contact_email: "SimmonsMMA26@gmail.com",
  contact_phone: "(469) 307 6899",
  zelle_handle: "4693076899",
  cashapp_tag: "$ConnorSimmons2022",
  timezone: "America/Chicago",
  cancel_window_hours: 12,
  min_notice_hours: 12,
  // Weekly hours, coach's local time (minutes after midnight). Mon–Fri 3–8 PM, Sat 9 AM–2 PM.
  availability: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: 900, end: 1200 })).concat([{ weekday: 6, start: 540, end: 840 }]),
};
