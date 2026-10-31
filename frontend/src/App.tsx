import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Armchair, Car, ChevronDown, Fingerprint, Gauge, Languages, Monitor, Play, Plus, ScanFace, ShieldAlert, Sparkles, Square, Trash2 } from 'lucide-react';
import type { CarState, ChatMessage, Intent, ProfileId, Toast } from './types';
import { SCENES } from './scenes';
import { getTimeGreeting, initialCar, runIntents } from './state/car';
import { parseCommand, type NluContext, type ParseResult } from './nlu/parser';
import { carAudio } from './lib/audio';
import { engine } from './lib/engine';
import { speak, useSpeechRecognition } from './lib/speech';
import { ApiError, BACKEND_DOMAIN, backend, recordAudio, toIntent, type BackendHealth, type Entitlement, type SpeakerStatus, type Transcription, type WindSettings, type WindTestResult } from './lib/backend';
import { suggestionsFor } from './lib/intents';
import { Cockpit, type CockpitView } from './components/Cockpit';
import type { VoicePhase } from './components/Infotainment';
import { VoiceDock } from './components/VoiceDock';
import { SettingsMenu } from './components/SettingsMenu';
import { BharatConnect } from './components/BharatConnect';
import { DriverMonitor } from './components/DriverMonitor';
import { SafeExitGuardian } from './components/SafeExitGuardian';
import { Transcript } from './components/Transcript';
import { SeatView } from './components/SeatView';
import { PROFILES, removeProfile, useProfileIds, useProfiles } from './lib/profiles';
import { AddProfileModal } from './components/AddProfileModal';
import { getShortcuts, saveShortcut, deleteShortcut, matchShortcut, parseTeachUtterance, describeActions } from './lib/shortcuts';

const VIEWS = [['cabin', 'Cabin', Car], ['dash', 'Dashboard', Gauge], ['screen', 'Screen', Monitor], ['seats', 'Seats', Armchair]] as const;
const NEXT_VIEW = { cabin: 'dash', dash: 'screen', screen: 'seats', seats: 'cabin' } as const;
const THINK_MS = 420;

const NEXT_SCENE = { live: 'night', night: 'day', day: 'live' } as const;
const SCENE_LABEL = { live: 'Live view', night: 'Night photo', day: 'Day photo' } as const;

const DEMO_SCRIPT = [
  'Namaste Verna',
  'Gaadi start karo',
  'AC 20 pe kar do',
  'Garmi lag rahi hai',
  'Romantic gaane chalao',
  'Light gulabi kar do',
  'Light ko music ke saath sync karo',
  'Volume thoda badhao',
  'Baarish ho rahi hai',
  'Ghar le chalo',
  'Gear D mein daalo aur right indicator do',
  'Sport mode on karo',
  'Cruise 60 pe set karo',
  'Tyre pressure kitna hai?',
  'Wiper band karo aur music band kar do',
  'Cruise band karo',
];

let nextId = 1;

interface Routed {
  intents: Intent[];
  /** Backend reply for turns that change nothing (questions, refusals, saved shortcuts). */
  say?: string;
  engine: 'backend' | 'local' | 'llm' | 'cloud';
  awaitingConfirm?: boolean;
}

// Both sides read the command the same way: keep the local intent, which carries richer
// slots (genre, exact level, mute, "feeling hot").
function agrees(local: Intent, remote: Intent) {
  const sign = (i: Intent) => ('delta' in i && i.delta ? Math.sign(i.delta) : 0);
  const flag = (i: Intent) => ('on' in i ? i.on : 'dir' in i ? i.dir : undefined);
  return local.type === remote.type && (sign(local) === 0 || sign(local) === sign(remote)) && flag(local) === flag(remote);
}

/**
 * Fast path first, command LLM for the rest. Clear commands take milliseconds:
 *  - the local parser understood every clause, and the commands lie outside the classifier's whitelist
 *    (compound commands, lights, gears, windows, questions...), or
 *  - the backend classifier acts with calibrated confidence (and agrees with the parser, if it read it).
 * The command LLM gets what neither can read with confidence: a clause the parser could not read, the
 * classifier unsure or calling it unsupported, or parser and classifier disagreeing. Its answer can hold
 * several commands. The backend's own questions (confirm an implicit request, ambiguous request, dialog
 * turns) and its refusals of negated requests ("AC band mat karo") stand as they are.
 */
// The local parser ignores negation, so a negated command must never reach it.
const NEGATION = /\b(?:don'?t|do not|never|mat|na karo|nahi?n? (?:karo|karna|chahiye))\b|मत|ना करो|नहीं करना/i;

/**
 * Which transcript to act on. The backend ranks its decoding passes with a classifier that knows only
 * climate, media, volume and navigation, so the parser judges them: a reading it understands completely
 * beats a partial one, and among those the reading most passes agree on wins (the passes err
 * independently: "gula bika" -> light on, "gulaabi" -> pink, "gulaabhi" -> pink). Ties keep the backend's order.
 */
function bestTranscript(t: Transcription, ctx: NluContext): string {
  const hyps = t.hypotheses?.length ? t.hypotheses : [t.text];
  const read = hyps.map((h) => { const p = parseCommand(h, ctx); return { h, sig: JSON.stringify(p.intents), level: p.intents.length ? (p.unparsed.length ? 1 : 2) : 0 }; });
  const votes = (sig: string) => read.filter((r) => r.sig === sig).length;
  const better = (x: (typeof read)[number], y: (typeof read)[number]) => x.level > y.level || (x.level === y.level && votes(x.sig) > votes(y.sig));
  return read.reduce((best, r) => (better(r, best) ? r : best), read[0]).h.trim();
}

async function route(text: string, parsed: ParseResult, server: BackendHealth | null, car?: CarState): Promise<Routed> {
  const teach = parseTeachUtterance(text);
  if (teach && car) {
    const actParsed = parseCommand(teach.actionText, {});
    let recipe = actParsed.intents;
    if (!recipe.length && server?.llm_ready) {
      recipe = (await backend.interpret(teach.actionText).catch(() => null))?.intents ?? [];
    }
    if (recipe.length > 0) {
      saveShortcut(car.profile, teach.trigger, recipe);
      const desc = describeActions(recipe, parsed.lang === 'hi' ? 'hi' : 'en');
      const say = parsed.lang === 'hi'
        ? `Shortcut '${teach.trigger}' save kar diya hai (${desc}).`
        : `Saved shortcut '${teach.trigger}' to ${desc}.`;
      return { intents: [], say, engine: 'local' };
    }
  }
  if (NEGATION.test(text)) {
    // The backend still sees it, e.g. "nahi chahiye" answering its pending question.
    const res = server ? await backend.text(text) : null;
    const refuse = parsed.lang === 'hi' ? 'Theek hai, nahi karunga.' : "Okay, I won't do that.";
    return { intents: [], say: res?.reason_code === 'cancelled_by_user' ? res.response_text : refuse, engine: res ? 'backend' : 'local' };
  }
  const local = parsed.intents;
  const localOnly = local.length > 1 || local.some((i) => !BACKEND_DOMAIN.has(i.type));
  if (!server || (localOnly && !parsed.unparsed.length)) return { intents: local, engine: 'local' };
  const llm = async () => (server.llm_ready ? (await backend.interpret(text).catch(() => null))?.intents ?? [] : []);

  // Several clauses, some not understood ("AC 22 kar do aur mahaul romantic bana do"): the LLM reads the
  // whole sentence. On the test set this beat both the parser's partial reading and LLM-on-the-unread-clauses-
  // only (53.6% vs 47.9% on multi-command sentences): a clause cut out of its sentence loses its meaning.
  // A single vague clause ("AC ka kuch karo") goes to the backend instead, which asks what was meant.
  if (local.length && parsed.unparsed.length && parsed.clauses > 1) {
    const intents = await llm();
    return intents.length ? { intents, engine: 'llm' } : { intents: local, engine: 'local' };
  }

  const res = await backend.text(text);
  if (res.decision === 'execute' && res.action) {
    const remote = toIntent(res.action);
    if (!remote) return { intents: local, engine: 'local' };
    // Shortcuts and dialog answers are the backend's; so is a command only the classifier read.
    if (res.source !== 'builtin' || !local.length) return { intents: [remote], engine: 'backend' };
    if (local.length === 1 && agrees(local[0], remote)) return { intents: [local[0]], engine: 'backend' };
    const intents = await llm(); // parser and classifier read it differently
    return intents.length ? { intents, engine: 'llm' } : { intents: [remote], engine: 'backend' };
  }
  const unsure = (res.decision === 'reject' && res.reason_code === 'unsupported_request')
    || (res.decision === 'clarify' && res.reason_code === 'low_confidence');
  if (unsure) {
    const intents = await llm();
    if (intents.length) return { intents, engine: 'llm' };
  }
  if (res.decision === 'reject' && res.reason_code === 'unsupported_request' && local.length) {
    return { intents: local, engine: 'local' };
  }
  return {
    intents: [],
    say: res.response_text || "Sorry, I didn't catch that.",
    engine: 'backend',
    awaitingConfirm: res.decision === 'ask_confirmation',
  };
}

/** What the premium LLM may need to resolve "thoda aur", "wapas", "same as before": a small, content-free snapshot. */
function snapshot(car: CarState) {
  return {
    climate: { on: car.climate.on, temp: car.climate.temp, fan: car.climate.fan },
    media: { playing: car.media.playing, volume: car.media.volume, muted: car.media.muted },
    ambient: { on: car.ambient.on, color: car.ambient.color },
    screen: car.screen, navigating_to: car.nav?.destination ?? null, drive_mode: car.driveMode,
  };
}

/**
 * Premium tier: the cloud LLM reads every transcript (it handles Tanglish, context and follow-ups the
 * on-device models don't). Only allowlisted commands come back; consequential ones wait for a spoken yes on
 * the server. If the cloud is unreachable, rate-limited or the subscription lapsed, the on-device route takes over.
 */
async function routePremium(text: string, parsed: ParseResult, server: BackendHealth | null, car: CarState): Promise<Routed> {
  try {
    const r = await backend.cloudInterpret(text, snapshot(car));
    if (r.status === 'execute' && r.actions.length) return { intents: r.actions, say: r.spoken_response, engine: 'cloud' };
    return { intents: [], say: r.spoken_response || "Sorry, I didn't catch that.", engine: 'cloud', awaitingConfirm: r.status === 'confirm' };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return { intents: [], say: 'Still working on the previous command.', engine: 'cloud' };
    return route(text, parsed, server, car);
  }
}

export default function App() {
  const [car, setCar] = useState<CarState>(initialCar);
  const carRef = useRef(car);
  const nlu = useRef<NluContext>({});
  const driverIdentified = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: nextId++, role: 'car', text: 'Namaste! I am your Verna. Speak or type in English, Hindi or Hinglish.' },
  ]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  // asks: the reply is a question (the mic reopens for the answer); confirm: a yes/no question.
  const [reply, setReply] = useState<{ text: string; intents: Intent[]; understood: boolean; asks: boolean; confirm: boolean } | null>(null);
  const [heard, setHeard] = useState<{ text: string; via: 'voice' | 'text' | 'chip' } | null>(null);
  const [server, setServer] = useState<BackendHealth | null>(null);
  // Voice tier from the backend's entitlement check (Settings shows it; the dev switch changes it there).
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const premium = !!server && !!entitlement?.premium_available;
  const premiumRef = useRef(premium);
  useEffect(() => { premiumRef.current = premium; }, [premium]);
  const serverRef = useRef(server);
  useEffect(() => { serverRef.current = server; }, [server]);
  const awaitingConfirm = useRef(false);
  // Opens the mic (if closed) for the answer to a question the car just asked; set once the mic exists.
  const listenForAnswer = useRef<() => void>(() => {});
  // BhashaDrive's own recogniser when the backend has one; the browser's otherwise.
  const [asrMode, setAsrMode] = useState<'browser' | 'server'>('server');
  const [recording, setRecording] = useState<{ stop: () => Promise<Blob> } | null>(null);
  const [asrError, setAsrError] = useState<string | null>(null);
  const [speechLang, setSpeechLang] = useState<'en-IN' | 'hi-IN'>('en-IN');
  const [tts, setTts] = useState(true);
  const [windSettings, setWindSettings] = useState<WindSettings | null>(null);
  const windSettingsRef = useRef<WindSettings | null>(null);
  const [windSaving, setWindSaving] = useState(false);
  const [browserNoiseSuppression, setBrowserNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(false);
  const [windTestLevelDb, setWindTestLevelDb] = useState(6);
  const [windTestBusy, setWindTestBusy] = useState(false);
  const [windTestError, setWindTestError] = useState<string | null>(null);
  const [windTestResult, setWindTestResult] = useState<WindTestResult | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [demo, setDemo] = useState<number | null>(null);
  const [view, setView] = useState<CockpitView>('cabin');
  // BharatConnect (driver <-> passenger translation) owns the microphone while it is open.
  const [bharatOpen, setBharatOpen] = useState(false);
  // Driver drowsiness monitoring by the cabin camera (components/DriverMonitor.tsx).
  const [monitorOn, setMonitorOn] = useState(false);
  // Safe Exit Guardian owns a separate webcam session; keep it mutually exclusive with DriverMonitor.
  const [safeExitOpen, setSafeExitOpen] = useState(false);
  const [teachingVoice, setTeachingVoice] = useState(false);
  const teachingRecRef = useRef<{ stop: () => Promise<Blob> } | null>(null);
  const [speakerStatus, setSpeakerStatus] = useState<SpeakerStatus | null>(null);
  const hasEnrolledSpeakers = !!speakerStatus && Object.values(speakerStatus.enrolled).some((n) => (n ?? 0) > 0);
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  const [addProfileOpen, setAddProfileOpen] = useState(false);

  const profileIds = useProfileIds();

  const profiles = useProfiles();

  const refreshSpeakers = useCallback(() => {
    backend.speakers().then(setSpeakerStatus, () => setSpeakerStatus(null));
  }, []);

  useEffect(() => {
    refreshSpeakers();
  }, [refreshSpeakers]);

  useEffect(() => {
    if (!showProfileMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target instanceof Element && e.target.closest('.teach-voice-group'))) {
        setShowProfileMenu(false);
      }
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [showProfileMenu]);

  const ttsRef = useRef(tts);
  useEffect(() => { ttsRef.current = tts; }, [tts]);
  useEffect(() => { windSettingsRef.current = windSettings; }, [windSettings]);

  const commit = useCallback((next: CarState) => {
    carRef.current = next;
    setCar(next);
  }, []);

  /** `speaker`: the driver profile the backend recognised from the voice, switched to before the command runs. */
  const handleCommand = useCallback((text: string, via: ChatMessage['via'], speaker?: ProfileId) => {
    carAudio.unlock();
    setMessages((m) => [...m, { id: nextId++, role: 'user', text, via }]);
    setHeard({ text, via: via ?? 'text' });
    setPhase('thinking');
    const started = Date.now();
    const parsed = parseCommand(text, nlu.current);
    let greeting = '';
    if (via === 'voice' && !driverIdentified.current && !parsed.intents.some((i) => i.type === 'profile')) {
      driverIdentified.current = true;
      if (speaker) {
        if (speaker !== carRef.current.profile) {
          const sw = runIntents(carRef.current, [{ type: 'profile', id: speaker }], parsed.lang, { speed: engine.speed });
          if (sw.state.profile === speaker) { // not refused (moving car)
            commit(sw.state);
            if (sw.toast) setToast({ ...sw.toast, id: nextId++ });
            const name = profiles[speaker]?.name || PROFILES[speaker]?.name || speaker;
            greeting = parsed.lang === 'hi' ? `Namaste ${name}, seat aapke hisaab se set. `
              : parsed.lang === 'ta' ? `Vanakkam ${name}, ungalukku seat set pannitten. `
              : parsed.lang === 'bn' ? `Nomoshkar ${name}, apnar seat set kore dilam. `
              : `Hi ${name}, I've set your seat. `;
          }
        } else {
          // Speaker matched current profile on first command: show confirmation toast once
          setToast({
            id: nextId++,
            icon: 'seat',
            label: `Driver: ${profiles[speaker]?.name || PROFILES[speaker]?.name || speaker}`,
            value: 'Voice recognized',
          });
        }
      } else {
        // Unrecognized voice on first command: fallback to default profile once
        if (carRef.current.profile !== 'default') {
          const sw = runIntents(carRef.current, [{ type: 'profile', id: 'default' }], parsed.lang, { speed: engine.speed });
          if (sw.state.profile === 'default') {
            commit(sw.state);
            if (sw.toast) setToast({ ...sw.toast, id: nextId++ });
            greeting = parsed.lang === 'hi'
              ? 'Aapki aawaz pehchaan nahi paaye, default profile set kar di hai. '
              : parsed.lang === 'ta'
                ? 'Kural adaiyaalam theriya villai, default profile set pannitten. '
                : parsed.lang === 'bn'
                  ? 'Golar aawaz chenaa gelo na, default profile set kore dilam. '
                  : 'Voice not recognized. Switched to Default profile. ';
          }
        }
      }
    }
    nlu.current = parsed.context;
    const online = serverRef.current !== null;

    const finish = ({ intents, say, engine: via, awaitingConfirm: awaiting }: Routed) => {
      awaitingConfirm.current = !!awaiting;
      let toExecute = intents;
      let shortcutToast: Toast | undefined;

      const createIntent = intents.find((i) => i.type === 'shortcut.create') as { type: 'shortcut.create'; trigger: string } | undefined;
      if (createIntent) {
        const recipe = intents.filter((i) => i.type !== 'shortcut.create');
        saveShortcut(carRef.current.profile, createIntent.trigger, recipe);
        toExecute = [];
        shortcutToast = { id: nextId++, icon: 'sparkles', label: 'Shortcut Saved', value: createIntent.trigger };
      }

      const deleteIntent = intents.find((i) => i.type === 'shortcut.delete') as { type: 'shortcut.delete'; trigger: string } | undefined;
      if (deleteIntent) {
        deleteShortcut(carRef.current.profile, deleteIntent.trigger);
        toExecute = [];
        shortcutToast = { id: nextId++, icon: 'sparkles', label: 'Shortcut Deleted', value: deleteIntent.trigger };
      }

      const listIntent = intents.find((i) => i.type === 'shortcut.list');
      if (listIntent) {
        const list = getShortcuts(carRef.current.profile);
        say = list.length
          ? `Saved shortcuts: ${list.map((s) => `'${s.trigger}' (${describeActions(s.actions)})`).join(', ')}.`
          : `No custom shortcuts saved yet. Try: "Whenever I say chill mode, set AC to 20 and ambient light to blue".`;
        toExecute = [];
      }

      const ran = toExecute.length ? runIntents(carRef.current, toExecute, parsed.lang, { speed: engine.speed }) : null;
      const out = {
        state: ran ? ran.state : carRef.current,
        text: (say || (ran ? ran.text : "Sorry, I didn't catch that.")),
        toast: shortcutToast || (ran ? ran.toast : undefined),
        understood: ran ? ran.understood : (say ? true : false),
      };
      out.text = greeting + out.text;
      commit(out.state);
      if (out.state.ignition === 'on' && intents.some((i) => i.type === 'rev')) engine.blip(1300);
      if (out.toast) setToast({ ...out.toast, id: nextId++ });
      setMessages((m) => [...m, { id: nextId++, role: 'car', text: out.text, intents, engine: online ? via : undefined }]);
      // The car asked something ("Should I...?", "Did you mean...?"): open the mic for the answer.
      const asks = !!awaiting || /\?\s*$/.test(say ?? '');
      setReply({ text: out.text, intents, understood: out.understood, asks, confirm: !!awaiting });
      carAudio.chime(out.understood ? 'ok' : 'error');
      const answerBack = () => { if (asks) window.setTimeout(() => listenForAnswer.current(), 300); }; // let the speaker fall silent
      if (ttsRef.current && 'speechSynthesis' in window) {
        speak(out.text,
          () => { setPhase('speaking'); carAudio.duck(true); },
          () => { setPhase('idle'); carAudio.duck(false); answerBack(); });
        // Some browsers never fire onstart without voices; don't get stuck.
        window.setTimeout(() => setPhase((p) => (p === 'thinking' ? 'idle' : p)), 1500);
      } else {
        setPhase('idle');
        answerBack();
      }
    };

    const matched = matchShortcut(carRef.current.profile, text);
    if (matched && matched.actions.length > 0) {
      const say = parsed.lang === 'hi'
        ? `${matched.trigger} activate kar diya.`
        : `${matched.trigger} activated.`;
      finish({
        intents: matched.actions,
        say,
        engine: 'local',
      });
      return;
    }

    (premiumRef.current && serverRef.current
      ? routePremium(text, parsed, serverRef.current, carRef.current)
      : route(text, parsed, serverRef.current, carRef.current))
      .catch((): Routed => {
        setServer(null); // backend went away: carry on with the local parser
        return { intents: parsed.intents, engine: 'local' };
      })
      // Typed commands get a short "thinking" beat; spoken ones already waited for speech recognition.
      .then((routed) => window.setTimeout(() => finish(routed), via === 'voice' ? 0 : Math.max(0, THINK_MS - (Date.now() - started))));
  }, [commit, profiles]);

  // Find the backend; recheck now and then so it can be started after the page.
  useEffect(() => {
    let first = true;
    const check = () => backend.health()
      .then((h) => {
        setServer(h);
        void backend.windSettings().then((settings) => {
          windSettingsRef.current = settings;
          setWindSettings(settings);
        }).catch(() => setWindSettings(null));
        void backend.entitlement().then((e) => {
          setEntitlement(e);
          if (first && e.configured && e.tier === 'free' && e.dev_tier_switch) {
            void backend.setDevTier('premium').then(setEntitlement).catch(() => {});
          }
        }, () => setEntitlement(null));
        if (first) { first = false; void backend.reset().catch(() => {}); }
      })
      .catch(() => { setServer(null); setEntitlement(null); });
    check();
    const t = window.setInterval(check, 15000);
    return () => window.clearInterval(t);
  }, []);

  // Touch controls on the virtual screen and dashboard skip the voice round-trip.
  // Touch controls on the virtual screen and dashboard skip the voice round-trip.
  const handleIntent = useCallback((intent: Intent) => {
    carAudio.unlock();
    const prevIgnition = carRef.current.ignition;
    const out = runIntents(carRef.current, [intent], 'en', { speed: engine.speed });
    commit(out.state);
    if (out.state.ignition === 'off') { driverIdentified.current = false; }
    // Picking a driver by hand identifies them: voice ID must not switch back to Default afterwards.
    else if (intent.type === 'profile' && out.state.profile === intent.id) { driverIdentified.current = true; }
    if (out.toast && intent.type !== 'screen') setToast({ ...out.toast, id: nextId++ });

    // When the car powers on into ACC or ON mode
    const isPoweringOn = intent.type === 'ignition' && 
      (out.state.ignition === 'acc' || out.state.ignition === 'on') && 
      out.state.ignition !== prevIgnition;

    if (isPoweringOn) {
      const g = getTimeGreeting();
      const welcomeText = `${g.en}!`;
      setReply({ text: welcomeText, intents: [{ type: 'greet' }], understood: true, asks: false, confirm: false });
      setMessages((m) => [...m, { id: nextId++, role: 'car', text: welcomeText }]);
      carAudio.chime('ok');
      if (ttsRef.current && 'speechSynthesis' in window) {
        speak(
          welcomeText,
          () => { setPhase('speaking'); carAudio.duck(true); },
          // A greeting, not a question: the mic stays closed.
          () => { setPhase('idle'); carAudio.duck(false); },
        );
      }
    }
  }, [commit]);

  const speechFailed = useRef<(code: string) => boolean>(() => false);
  const speech = useSpeechRecognition((text) => handleCommand(text, 'voice'), (code) => speechFailed.current(code));
  const serverAsr = !!server?.asr_ready;
  // Premium records in the browser for Sarvam on the backend, whatever the browser recogniser can do.
  const useServerAsr = premium || (serverAsr && (asrMode === 'server' || !speech.supported || hasEnrolledSpeakers));
  const micSupported = speech.supported || serverAsr || premium;

  const changeWindSettings = useCallback((patch: Partial<WindSettings>) => {
    const current = windSettingsRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    windSettingsRef.current = next;
    setWindSettings(next);
    setWindSaving(true);
    void backend.updateWindSettings(next)
      .then((saved) => {
        windSettingsRef.current = saved;
        setWindSettings(saved);
      })
      .catch(() => setWindTestError('Could not save wind settings'))
      .finally(() => setWindSaving(false));
  }, []);

  const runWindTest = useCallback(async () => {
    if (windTestBusy) return;
    if (!useServerAsr || !windSettings) {
      setWindTestError('Select Server ASR and make sure the backend is connected');
      return;
    }
    if (recording || speech.listening || teachingVoice) {
      setWindTestError('Stop the current microphone activity before starting the wind test');
      return;
    }
    try {
      setWindTestBusy(true);
      setWindTestError(null);
      setWindTestResult(null);
      setToast({ id: nextId++, icon: 'fan', label: 'Wind test', value: 'Speak one short command' });
      // Capture the clean reference without browser suppression. The backend
      // then adds deterministic synthetic wind and runs three ASR passes.
      const rec = await recordAudio(10000, 1200, { noiseSuppression: false, autoGainControl: false });
      const audio = await rec.done;
      setPhase('thinking');
      const result = await backend.windTest(audio, windTestLevelDb);
      setWindTestResult(result);
      setPhase('idle');
    } catch (err) {
      setPhase('idle');
      setWindTestError(err instanceof Error ? err.message : 'Wind test failed');
    } finally {
      setWindTestBusy(false);
    }
  }, [recording, speech.listening, teachingVoice, useServerAsr, windSettings, windTestBusy, windTestLevelDb]);

  // Server speech recognition: record in the browser, transcribe on the backend (Whisper).
  const toggleServerMic = useCallback(async () => {
    if (recording) { void recording.stop(); return; } // the `done` handler below transcribes
    try {
      setAsrError(null);
      const r = await recordAudio(8000, 900, { noiseSuppression: browserNoiseSuppression, autoGainControl });
      setRecording(r);
      // Ends on the mic button, on a pause after speech, or at the length limit.
      void r.done.then(async (audio) => {
        setRecording(null);
        if (premiumRef.current) {
          setPhase('transcribing');
          try {
            const t = await backend.cloudTranscribe(audio);
            if (t.fallback) setToast({ id: nextId++, icon: 'power', label: 'Cloud speech unavailable', value: 'Used on-device recognition' });
            if (t.text.trim()) { handleCommand(t.text.trim(), 'voice', driverIdentified.current ? undefined : t.speaker?.profile); return; }
            setPhase('idle');
            setAsrError(t.error ?? 'No speech heard. Try again.');
            return;
          } catch (e) {
            // Subscription lapsed / not configured / busy: fall through to the on-device recogniser.
            if (e instanceof ApiError && (e.status === 409 || e.status === 413 || e.status === 400 || e.status === 429)) {
              setPhase('idle');
              setAsrError(e.message);
              return;
            }
            void backend.entitlement().then(setEntitlement, () => {});
          }
        }
        setPhase('thinking');
        try {
          const t = await backend.transcribe(audio);
          console.log('[Voice Command] Transcribe result:', t);
          if (t.text.trim()) handleCommand(bestTranscript(t, nlu.current), 'voice', t.speaker?.profile);
          else { setPhase('idle'); setAsrError(t.error ?? 'No speech heard. Try again.'); }
        } catch {
          setPhase('idle');
          setAsrError('Server speech recognition failed');
        }
      });
    } catch {
      setAsrError('Microphone permission denied');
    }
  }, [recording, handleCommand, browserNoiseSuppression, autoGainControl]);

  // Teach the car the active driver's voice from the topbar button.
  const toggleTeachVoice = useCallback(async () => {
    carAudio.unlock();
    if (teachingRecRef.current) {
      try {
        await teachingRecRef.current.stop();
      } catch {
        // finished
      }
      return;
    }

    const activeProfile = carRef.current.profile;
    if (activeProfile === 'default') {
      setToast({
        id: nextId++,
        icon: 'seat',
        label: 'Default Profile',
        value: 'Please create a driver profile to teach voice',
      });
      setAddProfileOpen(true);
      return;
    }
    const profileName = (profiles[activeProfile] ?? PROFILES[activeProfile]).name;

    try {
      setTeachingVoice(true);
      setAsrError(null);
      setToast({
        id: nextId++,
        icon: 'seat',
        label: `Listening to ${profileName}`,
        value: 'Speak to teach voice',
      });

      const rec = await recordAudio(9000, 1400, { noiseSuppression: browserNoiseSuppression, autoGainControl });
      teachingRecRef.current = rec;

      const audio = await rec.done;
      teachingRecRef.current = null;
      setPhase('thinking');

      // Enroll voice embedding in CAM++ only (do NOT execute what was spoken - this is strictly training)
      const res = await backend.enroll(activeProfile, audio);
      refreshSpeakers();
      const samples = res.samples;

      const replyMsg = `Voice learned for ${profileName}. Sample ${samples} saved.`;
      setMessages((m) => [...m, { id: nextId++, role: 'car', text: replyMsg }]);
      setReply({ text: replyMsg, intents: [], understood: true, asks: false, confirm: false });
      setToast({
        id: nextId++,
        icon: 'seat',
        label: `Voice Learned: ${profileName}`,
        value: `${samples} sample${samples > 1 ? 's' : ''} stored (not executed)`,
      });
      carAudio.chime('ok');
      if (ttsRef.current && 'speechSynthesis' in window) {
        speak(replyMsg, () => { setPhase('speaking'); carAudio.duck(true); }, () => { setPhase('idle'); carAudio.duck(false); });
      } else {
        setPhase('idle');
      }
    } catch (err) {
      teachingRecRef.current = null;
      setPhase('idle');
      const msg = err instanceof Error ? err.message : String(err);
      const isShort = msg.toLowerCase().includes('at least') || msg.toLowerCase().includes('short') || msg.toLowerCase().includes('speech');
      const modelMissing = msg.toLowerCase().includes('speaker model') || msg.toLowerCase().includes('speaker runtime');
      setToast({
        id: nextId++,
        icon: 'seat',
        label: 'Voice Training',
        value: isShort ? 'Sample too short (need 2s+)' : modelMissing ? 'Install the speaker model, then restart' : 'Enrollment failed',
      });
      carAudio.chime('error');
    } finally {
      setTeachingVoice(false);
    }
  }, [profiles, refreshSpeakers, browserNoiseSuppression, autoGainControl]);

  // Chrome's recogniser streams audio to Google; when that fails ("network"), carry on with the
  // backend's Whisper for the rest of the session and keep listening, so the driver need not repeat the tap.
  useEffect(() => {
    speechFailed.current = (code) => {
      if ((code !== 'network' && code !== 'service-not-allowed') || !serverAsr) return false;
      setAsrMode('server');
      if (!recording) void toggleServerMic();
      return true;
    };
  }, [serverAsr, recording, toggleServerMic]);

  const toggleMic = useCallback(() => {
    carAudio.unlock();
    if (windTestBusy) return;
    if (useServerAsr) {
      if (!recording) { window.speechSynthesis?.cancel(); carAudio.chime('listen'); }
      void toggleServerMic();
      return;
    }
    if (speech.listening) { speech.stop(); return; }
    window.speechSynthesis?.cancel();
    carAudio.chime('listen');
    speech.start(speechLang);
  }, [speech, speechLang, useServerAsr, recording, toggleServerMic, windTestBusy]);

  useEffect(() => {
    listenForAnswer.current = () => { if (micSupported && !recording && !speech.listening) toggleMic(); };
  }, [micSupported, recording, speech.listening, toggleMic]);

  // The flasher relay ticks while the hazards or an indicator are blinking
  useEffect(() => { carAudio.flasher(car.hazard || car.indicator !== 'off'); }, [car.hazard, car.indicator]);
  useEffect(() => () => carAudio.flasher(false), []);

  // Engine and vehicle model follow the ignition, gear selector, drive mode, cruise and Auto Hold
  useEffect(() => { engine.setIgnition(car.ignition, car.driveMode === 'sport'); }, [car.ignition, car.driveMode]);
  useEffect(() => { engine.setDrive(car.gear, car.driveMode); }, [car.gear, car.driveMode]);
  useEffect(() => { engine.setCruise(car.adas.cruise); }, [car.adas.cruise]);
  useEffect(() => { engine.autoHold = car.autoHold; }, [car.autoHold]);
  // Touching the brake cancels Smart Cruise, as in the real car.
  useEffect(() => {
    engine.onCruiseCancel = () => handleIntent({ type: 'cruise', on: false });
    return () => { engine.onCruiseCancel = undefined; };
  }, [handleIntent]);

  // Hold ↑ or W to accelerate, ↓ or S to brake (when not typing)
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const isThrottle = (e: KeyboardEvent) => (e.key === 'ArrowUp' || e.key.toLowerCase() === 'w') && !typing(e);
    const isBrake = (e: KeyboardEvent) => (e.key === 'ArrowDown' || e.key.toLowerCase() === 's') && !typing(e);
    const down = (e: KeyboardEvent) => {
      if (e.repeat || !(isThrottle(e) || isBrake(e))) return;
      e.preventDefault();
      carAudio.unlock();
      if (isBrake(e)) engine.setBrake(true);
      else engine.press();
    };
    const up = (e: KeyboardEvent) => {
      if (isThrottle(e)) engine.release();
      if (isBrake(e)) engine.setBrake(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // Music engine follows the media state
  const m = car.media;
  useEffect(() => {
    if (m.playing) carAudio.play(m.genre, m.track, m.radio);
    else carAudio.stop();
  }, [m.playing, m.genre, m.track, m.radio]);
  useEffect(() => { carAudio.setVolume(m.muted ? 0 : m.volume / 30); }, [m.volume, m.muted]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Space = push to talk (when not typing)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.code === 'Space' && !typing && micSupported && !bharatOpen) { e.preventDefault(); toggleMic(); }
      if (e.key.toLowerCase() === 'z' && !typing) setView((v) => NEXT_VIEW[v]);
      if (e.key === '/' && !typing) { e.preventDefault(); document.querySelector<HTMLInputElement>('.bar input')?.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [toggleMic, micSupported, bharatOpen]);

  // Guided demo: feed the next scripted line once the car has finished answering
  useEffect(() => {
    if (demo === null || phase !== 'idle') return;
    const done = demo >= DEMO_SCRIPT.length;
    const t = window.setTimeout(() => {
      if (done) { setDemo(null); return; }
      // The backend asks before acting on hints like "garmi lag rahi hai": say yes.
      if (awaitingConfirm.current) { handleCommand('Haan', 'chip'); return; }
      handleCommand(DEMO_SCRIPT[demo], 'chip');
      setDemo(demo + 1);
    }, done ? 0 : demo === 0 ? 300 : 1600);
    return () => window.clearTimeout(t);
  }, [demo, phase, handleCommand]);

  const scene = SCENES[car.scene];
  const livePhase: VoicePhase = teachingVoice ? 'listening' : speech.listening || recording ? 'listening' : phase;
  const status = {
    text: server ? `BhashaDrive NLU${server.mock ? ' (mock)' : ''} · English · हिन्दी · Hinglish` : 'Offline NLU · English · हिन्दी · Hinglish',
    online: !!server,
    detail: server ? `Backend connected: ${server.nlu} · ASR ${server.asr ?? 'none'}` : 'Backend not reachable: using the in-browser parser',
  };

  return (
    <div className={`app scene-${scene.id}`}>
      <Cockpit car={car} scene={scene} toast={toast} onIntent={handleIntent}
        view={view} onToggleFocus={() => setView((v) => (v === 'screen' ? 'cabin' : 'screen'))} onMic={toggleMic}
        voice={{ phase: livePhase, interim: speech.interim, reply: reply?.text ?? '' }} />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Myra</span>
          <span className="brand-sub">Smart Cockpit</span>
        </div>
        <div className="top-actions">

          <button className={demo !== null ? 'on' : ''} onClick={() => { carAudio.unlock(); setDemo(demo === null ? 0 : null); }}
            title="Run a guided demo">{demo !== null ? <Square /> : <Play />}<span>{demo !== null ? 'Stop demo' : 'Demo'}</span></button>
          <div className="views" role="radiogroup" aria-label="Camera view (Z)">
            {VIEWS.map(([v, label, Icon]) => (
              <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}
                title={`${label} view (Z)`}><Icon /><span>{label}</span></button>
            ))}
          </div>

          {/* Teach Voice Button with Driver Profile Selector */}
          <div className="teach-voice-group">
            <button
              className={`teach-voice-btn ${teachingVoice ? 'rec' : ''} ${(speakerStatus?.enrolled[car.profile] ?? 0) > 0 ? 'has-voice' : ''}`}
              onClick={() => void toggleTeachVoice()}
              title={teachingVoice ? 'Click to stop & save voice' : `Click to record & teach the car ${PROFILES[car.profile].name}'s voice`}
            >
              {teachingVoice ? (
                <>
                  <span className="rec-pulse-dot" />
                  <span>Recording... Stop</span>
                </>
              ) : (
                <>
                  <Fingerprint className="voice-icon" />
                  <span>Teach Voice</span>
                  <span className="teach-profile-tag" style={{ '--tag-c': PROFILES[car.profile].accent } as CSSProperties}>
                    {PROFILES[car.profile].name}
                    {(speakerStatus?.enrolled[car.profile] ?? 0) > 0 && (
                      <span className="voice-count-num">({speakerStatus?.enrolled[car.profile]})</span>
                    )}
                  </span>
                </>
              )}
            </button>
            <button
              className="teach-profile-picker-toggle"
              onClick={() => setShowProfileMenu((v) => !v)}
              title="Change driver profile to teach"
              aria-label="Change driver profile to teach"
            >
              <ChevronDown size={13} />
            </button>
            {showProfileMenu && (
              <div className="teach-profile-dropdown" role="menu">
                <div className="teach-dropdown-header">Driver Profiles:</div>
                {profileIds.map((id) => {
                  const prof = profiles[id] ?? PROFILES[id];
                  const count = speakerStatus?.enrolled[id] ?? 0;
                  const isActive = id === car.profile;
                  const isDefault = id === 'default';
                  return (
                    <div key={id} className="teach-dropdown-item-row">
                      <button
                        type="button"
                        role="menuitem"
                        className={`teach-dropdown-item ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          handleIntent({ type: 'profile', id });
                          setShowProfileMenu(false);
                        }}
                      >
                        <span className="prof-avatar" style={{ background: prof.accent }}>{prof.name[0]}</span>
                        <div className="prof-meta">
                          <span className="prof-name">
                            {prof.name}
                            {isDefault && <span className="default-pill">Default</span>}
                          </span>
                          <span className="prof-height">{prof.heightCm} cm · {prof.build}</span>
                        </div>
                        {!isDefault && (
                          <span className={`prof-enroll-tag ${count > 0 ? 'enrolled' : ''}`}>
                            {count > 0 ? `${count} voice` : 'No voice'}
                          </span>
                        )}
                      </button>
                      {!isDefault && (
                        <button
                          type="button"
                          className="prof-delete-btn"
                          title={`Delete ${prof.name}'s profile`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Delete driver profile "${prof.name}"?`)) {
                              removeProfile(id);
                              backend.forget(id).catch(() => {});
                              if (car.profile === id) {
                                handleIntent({ type: 'profile', id: 'default' });
                              }
                            }
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="teach-dropdown-add-btn"
                  onClick={() => {
                    setShowProfileMenu(false);
                    setAddProfileOpen(true);
                  }}
                >
                  <Plus size={14} />
                  <span>Add New Profile</span>
                </button>
              </div>
            )}
          </div>

          <button className={safeExitOpen ? 'on' : ''} onClick={() => {
            carAudio.unlock();
            setSafeExitOpen((v) => {
              const next = !v;
              if (next) setMonitorOn(false);
              return next;
            });
          }} title="Local object detection for the Safe Exit Guardian demo"><ShieldAlert /><span>Safe Exit</span></button>
          <button className={monitorOn ? 'on' : ''} onClick={() => {
            carAudio.unlock();
            setMonitorOn((v) => {
              const next = !v;
              if (next) setSafeExitOpen(false);
              return next;
            });
          }}
             title="Drowsiness detection with the cabin camera"><ScanFace /><span>Driver Monitor</span></button>
          <button className={bharatOpen ? 'on' : ''} onClick={() => setBharatOpen(true)} title="Two-way voice translation between driver and passenger">
            <Languages /><span>BharatConnect</span></button>

          {entitlement?.dev_tier_switch && (
            <div className="tier-toggle-pill" title={entitlement.tier === 'premium' ? (entitlement.premium_available ? `Active Tier: Premium (Sarvam + ${entitlement.llm_model})` : 'Active Tier: Premium (Local fallback - keys missing in .env)') : 'Active Tier: Free (Local on-device)'}>
              <button
                type="button"
                className={entitlement.tier === 'free' ? 'active' : ''}
                onClick={() => {
                  void backend.setDevTier('free').then((e) => {
                    setEntitlement(e);
                    setToast({ id: nextId++, icon: 'power', label: 'Voice AI Tier', value: 'Switched to Free (On-device)' });
                  });
                }}
              >
                Free
              </button>
              <button
                type="button"
                className={`premium ${entitlement.tier === 'premium' ? 'active' : ''}`}
                onClick={() => {
                  void backend.setDevTier('premium').then((e) => {
                    setEntitlement(e);
                    setToast({
                      id: nextId++,
                      icon: 'power',
                      label: 'Voice AI Tier',
                      value: e.premium_available
                        ? `Switched to Premium (Sarvam + ${e.llm_model})`
                        : 'Switched to Premium (Local fallback - add keys in .env)',
                    });
                  });
                }}
              >
                <Sparkles size={12} />
                <span>Premium</span>
              </button>
            </div>
          )}
          <SettingsMenu status={status} speechLang={speechLang} onLang={setSpeechLang}
            voiceTier={server ? entitlement : null}
            onDevTier={(tier) => void backend.setDevTier(tier).then(setEntitlement, () => {})}
            tts={tts} onTts={(v) => { setTts(v); if (!v) window.speechSynthesis?.cancel(); }}
             asr={serverAsr && speech.supported ? asrMode : undefined} onAsr={setAsrMode}
             sceneLabel={SCENE_LABEL[car.scene]} onNextScene={() => handleIntent({ type: 'scene', scene: NEXT_SCENE[car.scene] })}
             showLog={showLog} onLog={setShowLog}
             windSettings={windSettings} windSaving={windSaving} onWindSettings={changeWindSettings}
             browserNoiseSuppression={browserNoiseSuppression} onBrowserNoiseSuppression={setBrowserNoiseSuppression}
             autoGainControl={autoGainControl} onAutoGainControl={setAutoGainControl}
             windTestLevelDb={windTestLevelDb} onWindTestLevelDb={setWindTestLevelDb}
             windTestBusy={windTestBusy} windTestError={windTestError} windTestResult={windTestResult} onWindTest={() => void runWindTest()} />
        </div>
      </header>

      {view === 'seats' && <SeatView car={car} onIntent={handleIntent} />}

      {safeExitOpen && <SafeExitGuardian onClose={() => setSafeExitOpen(false)} />}

      {monitorOn && <DriverMonitor onClose={() => setMonitorOn(false)} />}

      {bharatOpen && <BharatConnect onClose={() => setBharatOpen(false)} />}

      {showLog && <Transcript messages={messages} onClose={() => setShowLog(false)} onClear={() => setMessages([])} />}

      <AddProfileModal
        isOpen={addProfileOpen}
        onClose={() => setAddProfileOpen(false)}
        onProfileCreated={(np) => handleIntent({ type: 'profile', id: np.id })}
      />

      <VoiceDock phase={livePhase} interim={speech.interim} heard={heard} reply={reply} error={speech.error ?? asrError}
        suggestions={[...getShortcuts(car.profile).map((s) => s.trigger), ...suggestionsFor(reply?.intents ?? [], !!reply?.confirm)]} supported={micSupported}
        onMic={toggleMic} onSend={handleCommand} />
    </div>
  );
}
