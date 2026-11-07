/**
 * Landing page copy, English.
 *
 * Every claim here is something the product does today — most of it is lifted
 * from the narration of the product tour. If a feature changes, change the
 * sentence; don't leave a promise the app no longer keeps.
 *
 * `hi.ts` must match this shape exactly; the type enforces it.
 */
const en = {
  meta: {
    title: "Digital menu, table ordering and kitchen printing for restaurants",
    description:
      "Diners scan the QR on their table and order from their phone. Orders land on a live board, the bill reaches their phone, and kitchen printing is there if you want it. No app for your diners. Start free.",
    ogTitle: "Your restaurant, without the noise.",
    ogBody: "Digital menu, ordering from the table and kitchen printing.",
  },
  nav: {
    how: "How it works",
    features: "Features",
    tour: "Tour",
    faq: "Questions",
    signIn: "Sign in",
    startFree: "Start free",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    switchLanguage: "हिन्दी",
    switchLanguageLabel: "हिन्दी में पढ़ें",
    skip: "Skip to content",
  },
  hero: {
    title: "Your restaurant,<br></br> without the noise.",
    lede: "Diners scan the QR on their table and order from their phone. Every order lands on your live board the moment it's placed, and the bill reaches their phone when they're done.",
    primary: "Start free",
    secondary: "Watch the 4-minute tour",
    fine: "No app for your diners. Runs on the phone or computer you already have.",
    stageLabel:
      "A table card with a QR code, a diner's phone showing the menu, and the live orders board where their order arrives.",
    toast: "New order",
  },
  problem: {
    lead: "Rush hour. Every table full. One waiter, ten orders.",
    lines: [
      "The dosa for table 3 goes to table 8.",
      "The bill takes longer than the meal.",
      "Table 6 has been waving for ten minutes.",
    ],
    close: "The problem isn't your kitchen. It's the system.",
  },
  how: {
    title: "From the first dish to the last bill",
    lede: "Five steps. You only do the first two once.",
    steps: [
      {
        title: "Build your menu",
        body: "Add sections, dishes, sizes and prices. Save, and it's live: what you see is exactly what your diners see.",
      },
      {
        title: "Put a QR on every table",
        body: "Each table gets its own card. Print it yourself, or order PVC cards and acrylic stands from us. The code keeps working even if you rename the table.",
      },
      {
        title: "Diners order from the table",
        body: "Scan, choose, place the order. No app, no login. Want another filter coffee later? They add a new round, and the first order stays as it was.",
      },
      {
        title: "The kitchen gets it",
        body: "Orders arrive on a live board with a chime. Accept them, mark them ready, and if you've connected a printer, the kitchen ticket prints too.",
      },
      {
        title: "The bill, then a rating",
        body: "Close the table and the bill reaches the diner's phone, tax included. Then one question: how was the food?",
      },
    ],
  },
  features: {
    title: "Made for the busiest hour of your day",
    design: {
      title: "Your menu, your look",
      body: "Three layouts, five type pairings and a colour that matches your brand. The phone preview changes as you choose, so you don't need a designer.",
      layouts: ["Editorial", "Compact", "Grid"],
      previous: "Previous design",
      next: "Next design",
    },
    board: {
      title: "Every table, every round, at a glance",
      body: "Orders move from New to Being made to Ready. A table that orders again rises to the top as running, so nothing waits unseen. Every new order rings a chime.",
    },
    print: {
      badge: "Optional",
      title: "Want paper in the kitchen? Plug in a printer.",
      body: "You don't need one. But if your kitchen likes paper, open Chrome on any counter computer, plug in a 58 or 80 mm thermal printer and choose what it prints. Run all three jobs from one machine, or put the kitchen ticket in the kitchen and the rest at the counter.",
      jobs: [
        { name: "Token slip", note: "For the diner, with a big token number" },
        { name: "Kitchen ticket", note: "Dishes and notes only, for the cooks" },
        { name: "Bill", note: "Every round together, when the table closes" },
      ],
    },
    detailsTitle: "And the things you'd otherwise learn the hard way",
    details: [
      {
        title: "Round two arrives as round two",
        body: "New items show up on their own, on the board and on any ticket, so the kitchen never cooks the first order twice.",
      },
      {
        title: "A failed print never stops an order",
        body: "Out of paper? The order still goes through, the print retries on its own, and one click reprints it.",
      },
      {
        title: "Kitchen staff see orders, not money",
        body: "Staff get their own login to accept orders and mark them ready. Bills and takings stay with the owner.",
      },
      {
        title: "Each table sees only its own order",
        body: "Every table card carries a private link, so nobody can open another table's order.",
      },
      {
        title: "Feedback reaches you first",
        body: "After the bill, diners can leave a Google review or send a private note straight to you.",
      },
      {
        title: "Service charge, handled fairly",
        body: "Add one to the bill and diners can choose to remove it. Tax is shown clearly.",
      },
    ],
  },
  cards: {
    title: "Codes that look at home on your tables",
    body: "Download a print-ready card for every table, or order PVC cards, epoxy tags and acrylic stands from your dashboard. Each one carries that table's own code, and it never expires.",
  },
  tour: {
    title: "Watch a full service in four minutes",
    body: "Building the menu, a diner ordering from the table, the kitchen ticket printing and the bill at the end. Narrated in Hinglish.",
    play: "Play the tour",
    transcript: "Read the transcript",
  },
  faq: {
    title: "Questions owners ask",
    items: [
      {
        q: "Do my diners need to download an app?",
        a: "No. They scan the QR on the table and the menu opens in their phone's browser. No app, no login.",
      },
      {
        q: "Do I need a printer?",
        a: "No. Everything runs on the live board, on any phone, tablet or computer. If your kitchen prefers paper, plug a 58 or 80 mm thermal printer into a computer running Chrome or Edge and it prints kitchen tickets, token slips and bills.",
      },
      {
        q: "What if the printer runs out of paper mid-service?",
        a: "The order still goes through. The print retries on its own, the screen shows what didn't print, and you can reprint any ticket with one click.",
      },
      {
        q: "Can I change the menu during service?",
        a: "Yes. Changes go live the moment you save, and the QR codes on your tables stay exactly the same.",
      },
      {
        q: "Can kitchen staff use it without seeing the accounts?",
        a: "Yes. Add them under Staff and they get their own login, with the orders board and the dish list only.",
      },
      {
        q: "Is it only for restaurants?",
        a: "It works for restaurants, cafés and cinema snack counters, with a menu layout that suits how each one is read.",
      },
    ],
  },
  final: {
    title: "Set it up tonight. Run tomorrow's lunch on it.",
    body: "Build your menu, print the codes, and let your tables order for themselves.",
    primary: "Start free",
    secondary: "Sign in",
  },
  footer: {
    tagline: "Digital menu, ordering from the table and kitchen printing, for restaurants and cafés.",
    productOf: "A product of <link>irad.solutions</link>",
    product: "Product",
    account: "Account",
    language: "Language",
    rights: "All rights reserved.",
  },
};

export default en;
export type Messages = typeof en;
