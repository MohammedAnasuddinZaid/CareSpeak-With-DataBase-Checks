"use client";

/**
 * The site bar.
 *
 * Rebuilt around one rule: **the row never has to shrink a label to fit, and it
 * never has to hide anything to fit either.** The previous version answered a
 * crowded bar by splitting it into two presentations of the same thing — a full
 * text rail on wide screens and an icon rail from 1024px up, with the hamburger
 * sitting at the end of the icon rail the whole time. That produced the two
 * states that read as broken: a 1024–1400px band where eight destinations
 * collapsed into icon pills immediately beside the waymark, and a desktop row
 * that carried the destinations, a search box, a language picker, an account
 * control, Emergency and a hamburger all at one visual weight.
 *
 * So the fix is structural rather than responsive. The row is three zones and
 * only three zones, and each zone answers one question:
 *
 *   LEFT   — where am I?          The waymark, and nothing else. No status pill,
 *                                   no badge, no second word. (The "Preview" tag
 *                                   that used to sit here was the thing crowding
 *                                   the logo.)
 *   CENTRE — where can I go?       Three destinations: Nurse, Ward, Logs. These
 *                                   are the screens a nurse opens repeatedly in
 *                                   a shift, so they are the only ones allowed
 *                                   to hold a permanent slot. They are centred
 *                                   in the space the two outer zones leave, so
 *                                   they sit optically in the middle of the
 *                                   window rather than drifting toward whichever
 *                                   side happens to be narrower.
 *   RIGHT  — what can I do here?  Search, language, account, and Emergency. All
 *                                   system-level acts, so they are grouped
 *                                   together and separated from navigation by a
 *                                   hairline.
 *
 * Everything that does not earn a permanent slot is one click away in a dropdown
 * or one keystroke away in the palette:
 *
 *   - Hand Mode and Eye Mode are **not two destinations**. They are two input
 *     methods of the same workspace, so they do not take two permanent slots in
 *     the row. The bar keeps a single **Mode** button that opens the workspace,
 *     and the choice between input methods is the segmented toggle in that
 *     workspace's own header, made on the page you are actually working on. Both
 *     names stay in the palette and the drawer, so nothing became unreachable.
 *   - CCTV, Report and About moved into "More".
 *   - The wide `Search ⌘K` box became a square icon button that opens the palette
 *     as an overlay, so a 10rem-wide affordance no longer sits in the row at
 *     every width.
 *
 * Below 1024px the centre zone is removed entirely and the hamburger takes the
 * destinations. A hamburger and a text rail are alternatives, not companions —
 * showing both at once is the redundancy that made the bar look like it could
 * not decide what it was.
 *
 * Emergency is deliberately exempt from the disclosure: it keeps its label at
 * every width and stays the one filled control in the bar, because it must never
 * be two clicks away and must never be mistaken for navigation. It sits at the
 * far end of the right zone, past the hairline, where it reads as an action on
 * the current page rather than a place you can go.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BedDouble,
  Camera,
  ChevronDown,
  ClipboardList,
  CornerDownLeft,
  Ellipsis,
  Eye,
  FileText,
  Globe,
  Hand,
  Info,
  LogIn,
  LogOut,
  Menu,
  Search,
  X,
} from "lucide-react";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/types";
import { voiceAlert } from "@/lib/tts";
import { t, type UIKey } from "@/lib/i18n";
import { useUiLanguage } from "@/hooks/useUiLanguage";

type NavLink = {
  href: string;
  label: string;
  i18nKey?: UIKey;
  icon: typeof Hand;
  /** Drawer section heading. Only used below `lg`, where the rail is a drawer. */
  group?: string;
};

/** The bar is reduced to a waymark on the two auth routes: the sign-in page
 *  already carries the brand, the promise and the form, and a full destination
 *  rail above all three competes with them. */
const AUTH_ROUTES = ["/login", "/register"];

/**
 * Input methods, not destinations. These are absent from the bar on purpose —
 * see the file header — but they stay in the palette and the drawer so that a
 * patient on a ward tablet can still reach either workspace from anywhere,
 * and so removing them from the row does not make a screen unreachable.
 */
const WORKSPACES: NavLink[] = [
  { href: "/hand-mode", label: "Hand Mode", i18nKey: "handMode", icon: Hand, group: "Workspaces" },
  { href: "/eye-mode", label: "Eye Mode", i18nKey: "eyeMode", icon: Eye, group: "Workspaces" },
];

/** The way *into* a workspace, as opposed to a workspace itself.
 *
 *  Two separate "Hand Mode" / "Eye Mode" entries in the bar would claim two
 *  permanent slots for what is one screen with an input method, which is the
 *  mistake that emptied the bar in the first place. So the bar carries one
 *  button that opens the workspace, and the choice of input method is made by
 *  the segmented toggle already sitting in that workspace's header.
 *
 *  It lands on Hand Mode because that is the one with a camera-free path — a
 *  shared ward tablet should never open a page that immediately asks for camera
 *  permission before the patient has agreed to anything. Eye Mode is one tap
 *  away inside, and the toggle remembers nothing, so arriving here again lands
 *  on Hand every time, predictably. */
const MODE_LINK = {
  href: "/hand-mode",
  label: "Mode",
  icon: Hand,
} as const;

/** The workspace is one screen, so the button is "current" on either input
 *  method — landing on it from Eye Mode must not look like you left the page. */
const MODE_ROUTES = ["/hand-mode", "/eye-mode"];

/** The centre zone. Three screens, all of them high-frequency. */
const PRIMARY: NavLink[] = [
  { href: "/nurse-view", label: "Nurse", i18nKey: "nurse", icon: Activity, group: "Ward & clinical" },
  { href: "/ward", label: "Ward", i18nKey: "ward", icon: BedDouble, group: "Ward & clinical" },
  { href: "/logs", label: "Logs", i18nKey: "logs", icon: FileText, group: "Records" },
];

/** Behind "More". Reachable in one click, which is all a screen opened once a
 *  shift actually needs. */
const SECONDARY: NavLink[] = [
  { href: "/cctv", label: "CCTV", i18nKey: "cctv", icon: Camera, group: "Ward & clinical" },
  { href: "/report", label: "Report", i18nKey: "report", icon: ClipboardList, group: "Records" },
  { href: "/about", label: "About", i18nKey: "about", icon: Info, group: "Information" },
];

const EMERGENCY_LINK: NavLink = {
  href: "/emergency",
  label: "Emergency",
  i18nKey: "emergency",
  icon: AlertTriangle,
  group: "Ward & clinical",
};

/** Drawer section order, so the mobile sheet is grouped rather than a flat list. */
const DRAWER_GROUPS = ["Workspaces", "Ward & clinical", "Records", "Information"];

/** Everything the palette and the drawer can reach — a superset of the bar. */
const ALL_LINKS: NavLink[] = [...WORKSPACES, ...PRIMARY, ...SECONDARY, EMERGENCY_LINK];

/** Which overlay, if any, is open. One key rather than three booleans, so two
 *  panels can never be open at once and every toggle stays a one-liner. */
type Panel = "language" | "account" | "more" | "palette" | null;

/**
 * Spring curves.
 *
 * Every panel transition uses a spring rather than a duration, because a
 * dropdown that eases in and out at a fixed duration always reads as slightly
 * wrong: it either lags behind the click or arrives before the finger lifts. A
 * spring has no fixed duration, so it always arrives at the moment the gesture
 * ends, whatever the starting velocity was.
 *
 * The indicator is on a stiffer, lighter spring than the panels. It is a
 * continuous gesture — a shared element that slides between siblings — so it
 * needs to be quick and damped almost to a halt. Panels are discrete
 * open/close events and need to overshoot a touch so they feel physical.
 */
const PANEL_SPRING = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;
const INDICATOR_SPRING = { type: "spring", stiffness: 460, damping: 40, mass: 0.55 } as const;

/** Initials for the avatar: "Meera Iyer" -> "MI", single name -> first letter. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** "⌘K" on Apple platforms, "Ctrl K" everywhere else. */
function shortcutLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl K";
  const apple = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  return apple ? "⌘K" : "Ctrl K";
}

/** The glyph for the shortcut cap: the command key on Apple, "Ctrl" elsewhere. */
function shortcutGlyph(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
}

/** Case-insensitive match across the label and the path, so "eye" and "/cctv"
 *  both find their destination. */
function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();

  const [panel, setPanel] = useState<Panel>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [user, setUser] = useState<{ displayName: string; role: string } | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [shortcut, setShortcut] = useState({ text: "Ctrl K", glyph: "Ctrl" });

  const navRef = useRef<HTMLElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const isAuth = AUTH_ROUTES.includes(pathname);
  const isLanding = pathname === "/";
  // Solid whenever we are off the hero: the transparent treatment only stays
  // legible over the landing image. Auth routes are always solid — their brand
  // panel is dark on the left and the form column is light on the right, so
  // there is no single "background" for a transparent bar to sit on.
  const solid = isAuth || scrolled || !isLanding;

  const currentLang = useUiLanguage();
  const currentLangInfo = SUPPORTED_LANGUAGES[currentLang];
  const linkLabel = useCallback(
    (link: NavLink): string => (link.i18nKey ? t(currentLang, link.i18nKey) : link.label),
    [currentLang],
  );

  const dismiss = useCallback(() => {
    setPanel(null);
    setDrawerOpen(false);
  }, []);

  /**
   * Show who is signed in, and give them a way out.
   *
   * Without this the only way to sign out is to know the URL, and on a shared
   * ward tablet the next person inherits the previous nurse's live session —
   * including their access to every assigned patient's record.
   */
  useEffect(() => {
    if (isAuth) return;
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { user?: { displayName: string; role: string } } | null) => {
        if (!cancelled) setUser(d?.user ?? null);
      })
      .catch(() => {
        /* offline or unauthenticated: show the sign-in link */
      });
    return () => {
      cancelled = true;
    };
  }, [isAuth, pathname]);

  // A dropdown that survives navigation leaves a stale panel over the new page.
  useEffect(() => {
    dismiss();
  }, [pathname, dismiss]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
    dismiss();
    router.push("/login");
    router.refresh();
  }, [dismiss, router]);

  /**
   * Scroll position, read through a rAF-throttled handler.
   *
   * This used to be a plain `scroll` listener setting state directly, which
   * fires on every frame the user scrolls and re-renders the whole bar each
   * time. Worse, the state flip sat *next to* the paint: React committed, and
   * only then did the browser get around to the new background and shadow. The
   * result was a visible half-beat of lag between the first pixel of scroll and
   * the bar changing — the single most noticeable piece of jank in the product.
   *
   * Reading the position inside `requestAnimationFrame` and only committing when
   * the boolean actually changes fixes both: at most one read per frame, and no
   * render at all for the frames where nothing about the bar has to change.
   */
  useEffect(() => {
    let frame = 0;
    let current = window.scrollY > 24;

    const read = () => {
      frame = 0;
      const next = window.scrollY > 24;
      if (next !== current) {
        current = next;
        setScrolled(next);
      }
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    read();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    setShortcut({ text: shortcutLabel(), glyph: shortcutGlyph() });
  }, []);

  const openPalette = useCallback(() => {
    setDrawerOpen(false);
    setPanel("palette");
    setQuery("");
    setCursor(0);
  }, []);

  // Escape and outside-click both dismiss, so the menus are keyboard-usable and
  // do not sit there covering content after a stray click elsewhere. The palette
  // lives outside the <nav>, so it gets its own ref — without that exemption the
  // very first click in the search field would close the palette under the user.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (panel === "palette") dismiss();
        else openPalette();
        return;
      }
      if (e.key === "Escape") dismiss();
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (navRef.current?.contains(target)) return;
      if (paletteRef.current?.contains(target)) return;
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [dismiss, openPalette, panel]);

  // Whatever is open, the page behind it must not scroll under a finger, or the
  // list slides away from the cursor mid-tap.
  const overlayOpen = panel === "palette" || drawerOpen;
  useEffect(() => {
    if (!overlayOpen) return;
    document.documentElement.classList.add("nav-scroll-locked");
    return () => document.documentElement.classList.remove("nav-scroll-locked");
  }, [overlayOpen]);

  // Focus the search field as the palette mounts, so it is typeable immediately.
  useEffect(() => {
    if (panel !== "palette") return;
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [panel]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return ALL_LINKS;
    return ALL_LINKS.filter(
      (l) => matches(linkLabel(l), q) || matches(l.href, q) || matches(l.label, q),
    );
  }, [linkLabel, query]);

  // Keep the highlighted row inside the list as it narrows.
  useEffect(() => {
    setCursor((c) => (results.length ? Math.min(c, results.length - 1) : 0));
  }, [results.length]);

  const onPaletteKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[cursor];
      if (hit) {
        dismiss();
        router.push(hit.href);
      }
    }
  };

  const handleLanguageChange = (lang: SupportedLanguage) => {
    voiceAlert.setLanguage(lang);
    setPanel(null);
  };

  const activeHref = useMemo(
    () => (pathname === "/" ? null : (ALL_LINKS.find((l) => l.href === pathname)?.href ?? null)),
    [pathname],
  );

  // A workspace is a mode, not a destination, so being on /hand-mode must not
  // light any of the *destination* links. It does light the Mode entry, though —
  // that button is the way in, so standing on the far side of it should read as
  // "you are here". Emergency and the More trigger keep their own active
  // treatment instead of borrowing the shared indicator.
  const moreActive = useMemo(() => SECONDARY.some((l) => l.href === activeHref), [activeHref]);
  const modeActive = useMemo(() => MODE_ROUTES.includes(pathname), [pathname]);

  const drawerSections = useMemo(
    () =>
      DRAWER_GROUPS.map((group) => ({
        group,
        links: ALL_LINKS.filter((l) => l.group === group),
      })).filter((s) => s.links.length > 0),
    [],
  );

  /* ── Shared bits, so the dropdowns cannot drift from each other ── */

  const dropMotion = {
    initial: { opacity: 0, y: -6, scale: 0.97 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: -6, scale: 0.97 },
    transition: PANEL_SPRING,
  };

  const morePanel = (
    <motion.div {...dropMotion} className="nav-drop w-60 nav-drop--more">
      <p className="nav-drop__label">More</p>
      {SECONDARY.map((link) => {
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            className="nav-drop__item"
            aria-current={activeHref === link.href ? "page" : undefined}
          >
            <Icon aria-hidden="true" />
            <span className="truncate">{linkLabel(link)}</span>
            <span className="nav-drop__meta">{link.href}</span>
          </Link>
        );
      })}
    </motion.div>
  );

  const languagePanel = (
    <motion.div {...dropMotion} className="nav-drop w-56">
      <p className="nav-drop__label">Language</p>
      {(
        Object.entries(SUPPORTED_LANGUAGES) as [SupportedLanguage, { label: string; native: string }][]
      ).map(([code, info]) => (
        <button
          key={code}
          type="button"
          onClick={() => handleLanguageChange(code)}
          className="nav-drop__item"
          aria-current={currentLang === code ? "true" : undefined}
        >
          <Globe aria-hidden="true" />
          <span className="truncate">{info.native}</span>
          <span className="nav-drop__meta">{info.label}</span>
        </button>
      ))}
    </motion.div>
  );

  const accountPanel = user ? (
    <motion.div {...dropMotion} className="nav-drop w-64">
      <div className="nav-drop__head">
        <p className="truncate">{user.displayName}</p>
        <span className="capitalize">{user.role}</span>
      </div>
      <Link href="/ward" className="nav-drop__item">
        <BedDouble aria-hidden="true" />
        Ward board
      </Link>
      <button type="button" onClick={signOut} className="nav-drop__item nav-drop__item--danger">
        <LogOut aria-hidden="true" />
        Sign out
      </button>
    </motion.div>
  ) : null;

  return (
    <>
      <nav
        ref={navRef}
        aria-label="Primary"
        data-solid={solid ? "true" : "false"}
        className={`nav-shell ${isAuth ? "nav-shell--slim" : ""}`}
      >
        <div className="nav-inner">
          <div className="nav-rail">
            {/* ── Zone 1: waymark. The logo and the wordmark are one lockup and
                never separate; nothing else is allowed to share this zone. ── */}
            <div className="nav-group nav-group--tight">
              <Link href="/" className="nav-brand" aria-label="CareSpeak — home">
                <span className="nav-brand__mark">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/logo.png" alt="" className="nav-brand__img" />
                </span>
                <span className="nav-brand__name">CareSpeak</span>
              </Link>
            </div>

            {/* ── Zone 2: navigation. Three links and nothing else, centred in
                the leftover space. Removed wholesale below 1024px, where the
                hamburger owns the destinations.

                A plain `div`, not a second `<nav>`: the outer element is already
                the primary navigation landmark, and nesting a landmark inside a
                landmark announces two separate regions to a screen reader where
                there is one. ── */}
            <div className="nav-group nav-group--destinations nav-group--hide-slim">
              {/* The workspace entry, in the brand fill so it reads as the one
                  thing you came here to do rather than a fourth equal
                  destination. The other three are places a nurse *reads*; this
                  is the thing a patient *does*. */}
              <Link
                href={MODE_LINK.href}
                data-tip={`Open ${MODE_LINK.label}`}
                aria-label={`Open ${MODE_LINK.label} workspace`}
                className="nav-mode"
                aria-current={modeActive ? "page" : undefined}
              >
                <MODE_LINK.icon className="nav-mode__icon" aria-hidden="true" />
                <span className="nav-mode__label">{MODE_LINK.label}</span>
              </Link>
              {PRIMARY.map((link) => {
                const Icon = link.icon;
                const active = activeHref === link.href;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    data-tip={linkLabel(link)}
                    aria-label={linkLabel(link)}
                    className="nav-link nav-tip"
                    aria-current={active ? "page" : undefined}
                  >
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        className="nav-indicator"
                        transition={INDICATOR_SPRING}
                      />
                    )}
                    <Icon className="nav-link__icon" aria-hidden="true" />
                    <span className="nav-link__label">{linkLabel(link)}</span>
                  </Link>
                );
              })}
            </div>

            {/* ── Zone 3: what you can do here. Search, disclosure, language,
                account, then Emergency past the seam. Every child below is
                already guarded by `!isAuth`, so on the auth routes this group
                collapses to the hamburger alone — a way out of the form and
                nothing more, which is the whole intent of the slim bar. ── */}
            <div className="nav-group nav-group--tight">
              {!isAuth && (
                <button
                  type="button"
                  onClick={openPalette}
                  className="nav-btn nav-search"
                  data-tip={`Search — ${shortcut.text}`}
                  aria-label={`Search destinations (${shortcut.text})`}
                >
                  <Search className="nav-btn__icon" aria-hidden="true" />
                  <span className="kbd nav-search__kbd" aria-hidden="true">
                    {shortcut.glyph}
                  </span>
                </button>
              )}

              {!isAuth && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setPanel((p) => (p === "more" ? null : "more"))}
                    aria-expanded={panel === "more"}
                    aria-haspopup="true"
                    aria-current={moreActive ? "page" : undefined}
                    aria-label="More screens"
                    className="nav-btn nav-btn--more"
                  >
                    <Ellipsis className="nav-btn__icon" aria-hidden="true" />
                    <span className="nav-btn__label">More</span>
                    <ChevronDown className="nav-btn__chev" aria-hidden="true" />
                  </button>
                  <AnimatePresence>{panel === "more" && morePanel}</AnimatePresence>
                </div>
              )}

              {!isAuth && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setPanel((p) => (p === "language" ? null : "language"))}
                    aria-expanded={panel === "language"}
                    aria-haspopup="true"
                    aria-label={`Language: ${currentLangInfo.native}`}
                    data-tip={`Language · ${currentLangInfo.native}`}
                    className="nav-btn nav-btn--icon nav-tip"
                  >
                    <Globe className="nav-btn__icon" aria-hidden="true" />
                    <span className="nav-btn__label">{currentLangInfo.native}</span>
                    <ChevronDown className="nav-btn__chev" aria-hidden="true" />
                  </button>
                  <AnimatePresence>{panel === "language" && languagePanel}</AnimatePresence>
                </div>
              )}

              {user ? (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setPanel((p) => (p === "account" ? null : "account"))}
                    aria-expanded={panel === "account"}
                    aria-haspopup="true"
                    aria-label={`Account: ${user.displayName}`}
                    data-tip={user.displayName}
                    className="nav-btn nav-btn--avatar nav-btn--icon nav-tip"
                  >
                    <span className="nav-avatar" aria-hidden="true">
                      {initials(user.displayName)}
                    </span>
                  </button>
                  <AnimatePresence>{panel === "account" && accountPanel}</AnimatePresence>
                </div>
              ) : (
                !isAuth && (
                  <Link href="/login" className="nav-signin" data-tip="Sign in">
                    <LogIn className="nav-signin__icon" aria-hidden="true" />
                    Sign in
                  </Link>
                )
              )}

              {!isAuth && (
                <>
                  <span className="nav-sep" aria-hidden="true" />
                  <Link
                    href={EMERGENCY_LINK.href}
                    className="nav-emergency"
                    aria-current={activeHref === EMERGENCY_LINK.href ? "page" : undefined}
                  >
                    <AlertTriangle className="nav-emergency__icon" aria-hidden="true" />
                    {linkLabel(EMERGENCY_LINK)}
                  </Link>
                </>
              )}

              <button
                type="button"
                onClick={() => setDrawerOpen((v) => !v)}
                aria-expanded={drawerOpen}
                aria-controls="nav-drawer"
                aria-label={drawerOpen ? "Close menu" : "Open menu"}
                className="nav-btn nav-compact-only"
              >
                {drawerOpen ? (
                  <X className="nav-btn__icon" aria-hidden="true" />
                ) : (
                  <Menu className="nav-btn__icon" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile sheet. The complete set — including the two workspaces that
            have no slot in the bar — grouped by the section each one belongs to
            so the list is scannable rather than a flat column of nine rows.

            `transform` + `opacity` rather than `height`: the sheet is out of flow
            (see `.drawer`), so it never re-lays-out the page behind it, and the
            open stays on the compositor. `height: 0 → auto` over a list this
            long re-measured and re-laid-out on every frame, which is what made
            the sheet feel heavy on a tablet. */}
        <AnimatePresence initial={false}>
          {drawerOpen && (
            <motion.div
              id="nav-drawer"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={PANEL_SPRING}
              className="drawer"
            >
              <div className="drawer__scroll">
                {drawerSections.map(({ group, links }) => (
                  <div className="drawer__group" key={group}>
                    <p className="drawer__label">{group}</p>
                    <div className="drawer__items">
                      {links.map((link) => {
                        const Icon = link.icon;
                        const active = activeHref === link.href;
                        return (
                          <Link
                            key={link.href}
                            href={link.href}
                            onClick={dismiss}
                            className="drawer__link"
                            aria-current={active ? "page" : undefined}
                          >
                            <span className="drawer__icon">
                              <Icon aria-hidden="true" />
                            </span>
                            {linkLabel(link)}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <div className="drawer__group">
                  <p className="drawer__label">Account</p>
                  <div className="drawer__items">
                    {user ? (
                      <>
                        <div className="drawer__who">
                          <p>{user.displayName}</p>
                          <span className="capitalize">{user.role}</span>
                        </div>
                        <button
                          type="button"
                          onClick={signOut}
                          className="drawer__link drawer__link--danger"
                        >
                          <span className="drawer__icon">
                            <LogOut aria-hidden="true" />
                          </span>
                          Sign out
                        </button>
                      </>
                    ) : (
                      <Link href="/login" onClick={dismiss} className="drawer__link">
                        <span className="drawer__icon">
                          <LogIn aria-hidden="true" />
                        </span>
                        Sign in
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      {/* Command palette. Rendered outside the <nav> so its scrim covers the
          page rather than being clipped by the bar, and so the nav's
          outside-click handler cannot immediately dismiss it. */}
      <AnimatePresence>
        {panel === "palette" && (
          <motion.div
            className="cmdk-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onMouseDown={dismiss}
          >
            <motion.div
              ref={paletteRef}
              role="dialog"
              aria-modal="true"
              aria-label="Search destinations"
              className="cmdk"
              initial={{ opacity: 0, y: -14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.98 }}
              transition={PANEL_SPRING}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="cmdk__field">
                <Search aria-hidden="true" />
                <input
                  ref={searchRef}
                  className="cmdk__input"
                  placeholder="Jump to a screen…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCursor(0);
                  }}
                  onKeyDown={onPaletteKey}
                  role="combobox"
                  aria-expanded="true"
                  aria-controls="cmdk-list"
                  aria-label="Search destinations"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="kbd cmdk__kbd" aria-hidden="true">
                  esc
                </span>
              </div>

              <div className="cmdk__list" id="cmdk-list" role="listbox" aria-label="Results">
                <p className="cmdk__group">Screens</p>
                {results.length === 0 && (
                  <p className="cmdk__empty">
                    Nothing matches &ldquo;{query.trim()}&rdquo;. Try a screen name like ward or eye.
                  </p>
                )}
                {results.map((link, i) => {
                  const Icon = link.icon;
                  return (
                    <Link
                      key={link.href}
                      role="option"
                      aria-selected={i === cursor}
                      data-active={i === cursor ? "true" : "false"}
                      className="cmdk__item"
                      href={link.href}
                      onClick={dismiss}
                      onMouseEnter={() => setCursor(i)}
                    >
                      <Icon aria-hidden="true" />
                      {linkLabel(link)}
                      <span className="cmdk__item-hint">{link.href}</span>
                    </Link>
                  );
                })}
              </div>

              <div className="cmdk__foot">
                <span className="cmdk__foot-group">
                  <span className="kbd" aria-hidden="true">
                    &uarr;
                  </span>
                  <span className="kbd" aria-hidden="true">
                    &darr;
                  </span>
                  navigate
                </span>
                <span className="cmdk__foot-group">
                  <CornerDownLeft aria-hidden="true" />
                  open
                </span>
                <span className="cmdk__foot-group cmdk__foot-count">
                  {results.length} of {ALL_LINKS.length}
                </span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
