/**
 * Booking a demo, on Cal.com.
 *
 * Cal.com (AGPL-3.0) is the scheduling half of this: it owns the calendar, the
 * availability, the confirmation mail and the video link. Its Google Calendar
 * app is what puts a Google Meet on the invitation — an event type whose
 * location is "Google Meet" is booked with a Meet link already attached, which
 * is why there is no Google integration in this repository and no Google
 * credential anywhere near it. Self-hosting swaps one environment variable.
 *
 * The embed is loaded here and only here, when the booking page is opened, and
 * never on a page that merely links to it. A third-party script that runs on
 * every page is a third party watching every page, and the site would then owe
 * its readers a notice about it on all of them; loading it at the moment
 * someone asks to see a calendar is both faster and easier to be honest about.
 */
import { CAL } from "./auth/config";

/**
 * Where the embed's own bootstrap lives. On the hosted service the app is on a
 * different host from the marketing site the booking links point at; a
 * self-hosted instance serves both from the one origin.
 */
const EMBED_JS =
  CAL.origin === "https://cal.com"
    ? "https://app.cal.com/embed/embed.js"
    : `${CAL.origin}/embed/embed.js`;

/** Who is booking, when the site already knows — nobody should retype it. */
export interface Booker {
  readonly name?: string;
  readonly email?: string;
}

let loading: Promise<(...args: unknown[]) => unknown> | null = null;

async function load() {
  if (!loading) {
    loading = import("@calcom/embed-snippet").then(({ default: snippet }) =>
      snippet(EMBED_JS) as unknown as (...args: unknown[]) => unknown
    );
  }
  return loading;
}

/**
 * Fits the calendar into `element`. Resolves once the embed has been asked for
 * — Cal fills the box itself after that — and throws if the script will not
 * load, so the page can put its fallback up instead of an empty rectangle.
 */
export async function mountBooking(element: HTMLElement, booker: Booker = {}) {
  if (!CAL.link) throw new Error("no Cal.com event type is configured");

  const cal = await load();
  cal("init", { origin: CAL.origin });
  cal("ui", {
    // The wall is warm and light, and the embed sits on it rather than beside
    // it: Cal's light theme, with the site's own ink as the brand colour.
    theme: "light",
    cssVarsPerTheme: { light: { "cal-brand": "#16130f" } },
    hideEventTypeDetails: false,
    layout: "month_view",
  });
  cal("inline", {
    elementOrSelector: element,
    calLink: CAL.link,
    config: {
      layout: "month_view",
      theme: "light",
      // Prefilled, not imposed: Cal shows these in editable fields, so a person
      // booking for a colleague can still change them.
      ...(booker.name ? { name: booker.name } : {}),
      ...(booker.email ? { email: booker.email } : {}),
    },
  });
}
