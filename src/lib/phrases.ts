/**
 * Quick-access phrase board.
 *
 * Why this exists: the gesture engine could only ever say YES, NO, HELP, WATER
 * and PAUSE. A patient could report that something hurt, but not *where*, and
 * could not ask for a blanket, decline a visitor, or say they were cold.
 * AAC guidance is blunt about this — a board that only answers yes/no "should
 * not become the whole voice".
 *
 * Each phrase is emitted as a gesture entry, so it lands in the same log,
 * nurse console, report and audit chain as a camera gesture. The `id` doubles
 * as the persisted gesture name.
 *
 * TRANSLATIONS ARE PROVISIONAL. They are machine-provided and have not been
 * reviewed by a native speaker or a speech-language pathologist. A mistranslated
 * clinical phrase at a bedside is worse than no phrase, so review these before
 * clinical deployment. `PHRASES_NEED_LINGUISTIC_REVIEW` is surfaced in the UI.
 *
 * Nothing here may be blank: `phraseText` falls back to English rather than let
 * a patient select a tile that says nothing.
 */
import type { SupportedLanguage } from "@/types";

export const PHRASES_NEED_LINGUISTIC_REVIEW = true;

export type PhraseCategory = "basic" | "needs" | "medical" | "feelings" | "privacy";

export interface Phrase {
  /** Stable id, and the gesture name written to the clinical log. */
  id: string;
  category: PhraseCategory;
  /** lucide-react icon name, resolved in the component. */
  icon: string;
  /** Tiles that mean "something is wrong" are styled and spoken first. */
  urgent?: boolean;
  text: Record<SupportedLanguage, string>;
}

export const PHRASE_CATEGORIES: { id: PhraseCategory; label: string; icon: string }[] = [
  { id: "basic", label: "Basics", icon: "MessageSquare" },
  { id: "needs", label: "What I need", icon: "HandHeart" },
  { id: "medical", label: "How I feel", icon: "Stethoscope" },
  { id: "feelings", label: "Feelings", icon: "Heart" },
  { id: "privacy", label: "Privacy", icon: "Shield" },
];

export const PHRASES: Phrase[] = [
  // ── Basics ────────────────────────────────────────────────────────────────
  {
    id: "YES",
    category: "basic",
    icon: "Check",
    urgent: true,
    text: {
      "en-US": "Yes",
      "hi-IN": "हाँ",
      "bn-IN": "হ্যাঁ",
      "ta-IN": "ஆம்",
      "te-IN": "అవును",
      "mr-IN": "हो",
      "gu-IN": "હા",
      "kn-IN": "ಹೌದು",
      "ml-IN": "അതെ",
      "pa-IN": "ਹਾਂ",
    },
  },
  {
    id: "NO",
    category: "basic",
    icon: "X",
    urgent: true,
    text: {
      "en-US": "No",
      "hi-IN": "नहीं",
      "bn-IN": "না",
      "ta-IN": "இல்லை",
      "te-IN": "కాదు",
      "mr-IN": "नाही",
      "gu-IN": "ના",
      "kn-IN": "ಇಲ್ಲ",
      "ml-IN": "ഇല്ല",
      "pa-IN": "ਨਹੀਂ",
    },
  },
  {
    id: "PLEASE",
    category: "basic",
    icon: "Hand",
    text: {
      "en-US": "Please",
      "hi-IN": "कृपया",
      "bn-IN": "দয়া করে",
      "ta-IN": "தயவுசெய்து",
      "te-IN": "దయచేసి",
      "mr-IN": "कृपया",
      "gu-IN": "કૃપા કરીને",
      "kn-IN": "ದಯವಿಟ್ಟು",
      "ml-IN": "ദയവേട്ടു",
      "pa-IN": "ਕਿਰਪਾ ਕਰਕੇ",
    },
  },
  {
    id: "THANK_YOU",
    category: "basic",
    icon: "Heart",
    text: {
      "en-US": "Thank you",
      "hi-IN": "धन्यवाद",
      "bn-IN": "ধন্যবাদ",
      "ta-IN": "நன்றி",
      "te-IN": "ధన్యవాదాలు",
      "mr-IN": "धन्यवाद",
      "gu-IN": "આભાર",
      "kn-IN": "ಧನ್ಯವಾದಗಳು",
      "ml-IN": "നന്മസം",
      "pa-IN": "ਧੰਨਵਾਦ",
    },
  },
  {
    id: "GOODBYE",
    category: "basic",
    icon: "LogOut",
    text: {
      "en-US": "Goodbye",
      "hi-IN": "अलविदा",
      "bn-IN": "বিদায়",
      "ta-IN": "பிற்விடுங்கள்",
      "te-IN": "బాయ్",
      "mr-IN": "नाया",
      "gu-IN": "આવજો",
      "kn-IN": "ಹುದ್ದು",
      "ml-IN": "വിട്ടുപോകാം",
      "pa-IN": "ਅਲਵਿਦਾ",
    },
  },
  {
    id: "I_DONT_KNOW",
    category: "basic",
    icon: "HelpCircle",
    text: {
      "en-US": "I don't know",
      "hi-IN": "मुझे नहीं पता",
      "bn-IN": "আমি জানি না",
      "ta-IN": "தெரியாது",
      "te-IN": "నాకు తెలియదు",
      "mr-IN": "मला माहीत नाही",
      "gu-IN": "મને ખબર નથી",
      "kn-IN": "ನನಗೆ ಗೊತ್ತಿಲ್ಲ",
      "ml-IN": "എനിക്ക് അറിയില്ല",
      "pa-IN": "ਮੈਨੂੰ ਨਹੀਂ ਪਤਾ",
    },
  },

  // ── What I need ───────────────────────────────────────────────────────────
  {
    id: "NEED_WATER",
    category: "needs",
    icon: "Droplets",
    text: {
      "en-US": "I need water",
      "hi-IN": "मुझे पानी चाहिए",
      "bn-IN": "আমার জল দরকার",
      "ta-IN": "தண்ணீர் தேவை",
      "te-IN": "నీటు కావాలి",
      "mr-IN": "मला पाणी हवे",
      "gu-IN": "મને પાણી જોઈએ",
      "kn-IN": "ನನಗೆ ನೀರು ಬೇಕು",
      "ml-IN": "എനിക്ക് വെള്ളം വേണം",
      "pa-IN": "ਮੈਨੂੰ ਪਾਣੀ ਚਾਹੀਦਾ",
    },
  },
  {
    id: "NEED_FOOD",
    category: "needs",
    icon: "Utensils",
    text: {
      "en-US": "I want food",
      "hi-IN": "मुझे खाना चाहिए",
      "bn-IN": "আমি খাবার চাই",
      "ta-IN": "சாப்பாடு தேவை",
      "te-IN": "భోజనం కావాలి",
      "mr-IN": "मला जेवण हवे",
      "gu-IN": "મને ખાવું જોઈએ",
      "kn-IN": "ಆಹಾರ ಬೇಕು",
      "ml-IN": "ഭക്ഷണം വേണം",
      "pa-IN": "ਮੈਨੂੰ ਖਾਣਾ ਚਾਹੀਦਾ",
    },
  },
  {
    id: "NEED_TOILET",
    category: "needs",
    icon: "DoorOpen",
    urgent: true,
    text: {
      "en-US": "I need the toilet",
      "hi-IN": "मुझे शौचालय जाना है",
      "bn-IN": "আমার বাথরুম যেতে হবে",
      "ta-IN": "கழிவறை செல்ல வேண்டும்",
      "te-IN": "మేము టoilet కు వెళ్లాలి",
      "mr-IN": "मला स्वच्छागृह जायचे आहे",
      "gu-IN": "મને શૌચાલય જવું છે",
      "kn-IN": "ನನಗೆ ಟೊಯ್ಲೆಟ್‌ಗೆ ಹೋಯಬೇಕು",
      "ml-IN": "എനിക്ക് ടോയ്ലറ്റിലേക്ക് പോയണം",
      "pa-IN": "ਮੈਨੂੰ ਟੌਇਲਿਟ ਜਾਣਾ ਹੈ",
    },
  },
  {
    id: "NEED_NURSE",
    category: "needs",
    icon: "UserRound",
    urgent: true,
    text: {
      "en-US": "I need a nurse",
      "hi-IN": "मुझे नर्स चाहिए",
      "bn-IN": "আমার একজন নার্স দরকার",
      "ta-IN": "ஒரு நர்ச் தேவை",
      "te-IN": "నర్స్ కావాలి",
      "mr-IN": "मला परिचारिका हवी",
      "gu-IN": "મને નર્સ જોઈએ",
      "kn-IN": "ನರ್ಸ್ ಬೇಕು",
      "ml-IN": "എനിക്ക് ഒരു നഴ്‌സ് വേണം",
      "pa-IN": "ਮੈਨੂੰ ਨਰਸ ਚਾਹੀਦੀ",
    },
  },
  {
    id: "NEED_DOCTOR",
    category: "needs",
    icon: "Stethoscope",
    urgent: true,
    text: {
      "en-US": "I need a doctor",
      "hi-IN": "मुझे डॉक्टर चाहिए",
      "bn-IN": "আমার একজন ডাক্তার দরকার",
      "ta-IN": "ஒரு மருத்துவர் தேவை",
      "te-IN": "వైద్యుడు కావాలి",
      "mr-IN": "मला डॉक्टर हवा",
      "gu-IN": "મને ડૉક્ટર જોઈએ",
      "kn-IN": "ವೈದ್ಯ ಬೇಕು",
      "ml-IN": "എനിക്ക് ഒരു ഡോക്ടർ വേണം",
      "pa-IN": "ਮੈਨੂੰ ਡਾਕਟਰ ਚਾਹੀਦਾ",
    },
  },
  {
    id: "NEED_BLANKET",
    category: "needs",
    icon: "Bed",
    text: {
      "en-US": "I need a blanket",
      "hi-IN": "मुझे कंबल चाहिए",
      "bn-IN": "আমার একটা কম্বল দরকার",
      "ta-IN": "ஒரு போர்வை தேவை",
      "te-IN": "దవసలు కావాలి",
      "mr-IN": "मला एक शाल हवी",
      "gu-IN": "મને કંબાળ જોઈએ",
      "kn-IN": "ಒಂದು ಮಾಡು ಬೇಕು",
      "ml-IN": "എനിക്ക് ഒരു പവ വേണം",
      "pa-IN": "ਮੈਨੂੰ ਕੰਬਲ ਚਾਹੀਦਾ",
    },
  },
  {
    id: "LIGHT_OFF",
    category: "needs",
    icon: "Lightbulb",
    text: {
      "en-US": "Turn off the light",
      "hi-IN": "बत्ती बंद करें",
      "bn-IN": "আলো বন্ধ করুন",
      "ta-IN": "விளக்கு அணைக்கவும்",
      "te-IN": "దీపం ఆర్థించండి",
      "mr-IN": "दिवा बंद करा",
      "gu-IN": "લાઈટ બંધ કરો",
      "kn-IN": "ದೀಪ ಆಫ್ ಮಾಡಿ",
      "ml-IN": "വെള്ളം ഓഫാക്കുക",
      "pa-IN": "ਲਾਈਟ ਬੰਦ ਕਰੋ",
    },
  },
  {
    id: "LIGHT_ON",
    category: "needs",
    icon: "Sun",
    text: {
      "en-US": "Turn on the light",
      "hi-IN": "बत्ती चालू करें",
      "bn-IN": "আলো জ্বালান",
      "ta-IN": "விளக்கு ஏற்றவும்",
      "te-IN": "దీపం వెలిగించండి",
      "mr-IN": "दिवा चालू करा",
      "gu-IN": "લાઈટ ચાલુ કરો",
      "kn-IN": "ದೀಪ ಹಚ್ಚಿ",
      "ml-IN": "വെള്ളം തെളിയിക്കുക",
      "pa-IN": "ਲਾਈਟ ਚਾਲੂ ਕਰੋ",
    },
  },
  {
    id: "NEED_FAN",
    category: "needs",
    icon: "Fan",
    text: {
      "en-US": "I need the fan",
      "hi-IN": "मुझे पंखा चाहिए",
      "bn-IN": "আমার ফ্যান দরকার",
      "ta-IN": "விசிறி தேவை",
      "te-IN": "ఫ్యాన్ కావాలి",
      "mr-IN": "मला पंखा हवा",
      "gu-IN": "મને ફેન જોઈએ",
      "kn-IN": "ಫ್ಯಾನ್ ಬೇಕು",
      "ml-IN": "എനിക്ക് ഫാൻ വേണം",
      "pa-IN": "ਮੈਨੂੰ ਪੰਖਾ ਚਾਹੀਦਾ",
    },
  },

  // ── How I feel ────────────────────────────────────────────────────────────
  {
    id: "IN_PAIN",
    category: "medical",
    icon: "Zap",
    urgent: true,
    text: {
      "en-US": "I am in pain",
      "hi-IN": "मुझे दर्द है",
      "bn-IN": "আমার ব্যথা আছে",
      "ta-IN": "எனக்கு வலி உள்ளது",
      "te-IN": "నాకు నోపు ఉంది",
      "mr-IN": "मला दुखत आहे",
      "gu-IN": "મને દરદ છે",
      "kn-IN": "ನನಗೆ ನೋವು ಇದೆ",
      "ml-IN": "എനിക്ക് വേദനയുണ്ട്",
      "pa-IN": "ਮੈਨੂੰ ਦਰਦ ਹੈ",
    },
  },
  {
    id: "WHERE_IS_PAIN",
    category: "medical",
    icon: "MapPin",
    urgent: true,
    text: {
      "en-US": "The pain is here",
      "hi-IN": "दर्द यहाँ है",
      "bn-IN": "ব্যথা এখানে",
      "ta-IN": "வலி இங்கே உள்ளது",
      "te-IN": "నోపు ఇక్కడ ఉంది",
      "mr-IN": "दुख इथे आहे",
      "gu-IN": "દરદ અહીં છે",
      "kn-IN": "ನೋವು ಇಲ್ಲಿದೆ",
      "ml-IN": "വേദന ഇവിടെയാണ്",
      "pa-IN": "ਦਰਦ ਇੱਥੇ ਹੈ",
    },
  },
  {
    id: "NEED_MEDICINE",
    category: "medical",
    icon: "Pill",
    text: {
      "en-US": "I need my medicine",
      "hi-IN": "मुझे दवा चाहिए",
      "bn-IN": "আমার ওষুধ দরকার",
      "ta-IN": "மருந்து தேவை",
      "te-IN": "మందులు కావాలి",
      "mr-IN": "मला औषधे हवी",
      "gu-IN": "મને દવા જોઈએ",
      "kn-IN": "ನನಗೆ ಔಷಧಿ ಬೇಕು",
      "ml-IN": "എനിക്ക് മരുന്ന് വേണം",
      "pa-IN": "ਮੈਨੂੰ ਦਵਾ ਚਾਹੀਦੀ",
    },
  },
  {
    id: "NEED_INHALER",
    category: "medical",
    icon: "Wind",
    text: {
      "en-US": "I need my inhaler",
      "hi-IN": "मुझे इनहेलर चाहिए",
      "bn-IN": "আমার ইনহেলার দরকার",
      "ta-IN": "இன்ஹேலர் தேவை",
      "te-IN": "ఇన్‌హేలర్ కావాలి",
      "mr-IN": "मला इनहेलर हवा",
      "gu-IN": "મને ઇનહેલર જોઈએ",
      "kn-IN": "ನನಗೆ ಇನ್‌ಹೇಲರ್ ಬೇಕು",
      "ml-IN": "എനിക്ക് ഇൻഹെയ്‌ലർ വേണം",
      "pa-IN": "ਮੈਨੂੰ ਇਨਹੇਲਰ ਚਾਹੀਦਾ",
    },
  },
  {
    id: "FEEL_DIZZY",
    category: "medical",
    icon: "RefreshCw",
    urgent: true,
    text: {
      "en-US": "I feel dizzy",
      "hi-IN": "मुझे चक्कर आ रहे हैं",
      "bn-IN": "আমার মাথা ঘোরে",
      "ta-IN": "தலை சுற்றுகிறது",
      "te-IN": "నాకు తల తిరుగుతోంది",
      "mr-IN": "मला चक्कर वाहत आहेत",
      "gu-IN": "મને ચક્કર આવે છે",
      "kn-IN": "ನನಗೆ ತಲೆ ಸುತ್ತುತ್ತದೆ",
      "ml-IN": "എനിക്ക് വിറ്റം വരുന്നു",
      "pa-IN": "ਮੈਨੂੰ ਚੱਕਰ ਆਉਂਦੇ",
    },
  },
  {
    id: "HARD_TO_BREATHE",
    category: "medical",
    icon: "AlertTriangle",
    urgent: true,
    text: {
      "en-US": "I cannot breathe well",
      "hi-IN": "मुझे सांस नहीं चल रही",
      "bn-IN": "আমার শ্বাস নিতে সমস্যা হচ্ছে",
      "ta-IN": "மூச்சு சிரிக்கிறது",
      "te-IN": "నాకు శ్వాస సులభంగా లేదు",
      "mr-IN": "मला श्वास घेणे कठीण होते आहे",
      "gu-IN": "મને શ્વાસ સામાન્ય રીતે આવતો નથી",
      "kn-IN": "ನನಗೆ ಉಡಿರೆಯಾಗುತ್ತಿಲ್ಲ",
      "ml-IN": "എനിക്ക് ശ്വാസം കൂടുതൽ ആകുന്നില്ല",
      "pa-IN": "ਮੈਂ ਢੁੱਕ ਨਹੀਂ ਲੈ ਸਕਦਾ",
    },
  },
  {
    id: "FEEL_SICK",
    category: "medical",
    icon: "Thermometer",
    text: {
      "en-US": "I feel unwell",
      "hi-IN": "मुझे बीमार लग रहा है",
      "bn-IN": "আমি অসুস্থ বোধ করছি",
      "ta-IN": "நலமில்லை",
      "te-IN": "నేను అనారోగ్యంగా భావిస్తున్నాను",
      "mr-IN": "मला बीमार वाटते आहे",
      "gu-IN": "મને બીમારી લાગે છે",
      "kn-IN": "ನನಗೆ ಅನಾರೋಗ್ಯ ಆಗಿದೆ",
      "ml-IN": "എനിക്ക് സ്വകാരം തോന്നുന്നു",
      "pa-IN": "ਮੈਨੂੰ ਮਾਰਾ ਲੱਗ ਰਿਹਾ",
    },
  },

  // ── Feelings ──────────────────────────────────────────────────────────────
  {
    id: "FEEL_HAPPY",
    category: "feelings",
    icon: "Smile",
    text: {
      "en-US": "I am happy",
      "hi-IN": "मैं खुश हूँ",
      "bn-IN": "আমি খুশি",
      "ta-IN": "நான் மகிழ்ச்சியாக இருக்கிறேன்",
      "te-IN": "నేను సంతోషంగా ఉన్నాను",
      "mr-IN": "मी आनंदी आहे",
      "gu-IN": "હું ખુશ છું",
      "kn-IN": "ನನಗೆ ಸಂತೋಷ",
      "ml-IN": "ഞാൻ സന്തോഷമുണ്ട്",
      "pa-IN": "ਮੈਂ ਖੁਸ਼ ਹਾਂ",
    },
  },
  {
    id: "FEEL_SAD",
    category: "feelings",
    icon: "Frown",
    text: {
      "en-US": "I am sad",
      "hi-IN": "मैं उदास हूँ",
      "bn-IN": "আমি দুঃখিত",
      "ta-IN": "நாங்கள் வருத்தப்படுகிறோம்",
      "te-IN": "నేను బాధితుడను",
      "mr-IN": "मी दुःखी आहे",
      "gu-IN": "હું દુઃખી છું",
      "kn-IN": "ನನಗೆ ಬೇಸರ",
      "ml-IN": "എനിക്ക് വിഷമം ഉണ്ട്",
      "pa-IN": "ਮੈਂ ਉਦਾਸ ਹਾਂ",
    },
  },
  {
    id: "FEEL_SCARED",
    category: "feelings",
    icon: "Ghost",
    urgent: true,
    text: {
      "en-US": "I am frightened",
      "hi-IN": "मुझे डर लग रहा है",
      "bn-IN": "আমি ভয় পাচ্ছি",
      "ta-IN": "பயம் கொண்டுள்ளேன்",
      "te-IN": "నాకు భయం అవుతోంది",
      "mr-IN": "मला भीती वाटते आहे",
      "gu-IN": "મને ડર લાગે છે",
      "kn-IN": "ನನಗೆ ಭಯ ಆಗುತ್ತಿದೆ",
      "ml-IN": "എനിക്ക് ഭയമുണ്ട്",
      "pa-IN": "ਮੈਨੂੰ ਡਰ ਲੱਗ ਰਿਹਾ",
    },
  },
  {
    id: "FEEL_TIRED",
    category: "feelings",
    icon: "BatteryLow",
    text: {
      "en-US": "I am tired",
      "hi-IN": "मैं थका हुआ हूँ",
      "bn-IN": "আমি ক্লান্ত",
      "ta-IN": "நான் தச்சம் அடைந்துள்ளேன்",
      "te-IN": "నేను అలసగా ఉన్నాను",
      "mr-IN": "मी थकलो आहे",
      "gu-IN": "હું થાકી ગયો છું",
      "kn-IN": "ನನಗೆ ಆಯಸಂತಕ",
      "ml-IN": "ഞാൻ ക്ലിനിച്ചു",
      "pa-IN": "ਮੈਂ ਥਕ ਗਿਆ ਹਾਂ",
    },
  },
  {
    id: "FEEL_BETTER",
    category: "feelings",
    icon: "TrendingUp",
    text: {
      "en-US": "I feel better now",
      "hi-IN": "अब मैं बेहतर महसूस कर रहा हूँ",
      "bn-IN": "এখন আমি ভালো বুঝছি",
      "ta-IN": "இப்போது நான் நன்றாக உள்ளேன்",
      "te-IN": "ఇప్పుడు నేను బాగా ఉన్నాను",
      "mr-IN": "आता मला बरे वाटते आहे",
      "gu-IN": "હવે હું સારો છું",
      "kn-IN": "ಈಗ ನನಗೆ ಚೆನ್ನಾಗಿದೆ",
      "ml-IN": "ഇപ്പോൾ എനിക്ക് കുറയാണ്",
      "pa-IN": "ਹੁਣ ਮੈਂ ਬਿਲਕੁਲ ਮਹਸੂਸ ਕਰ ਰਿਹਾ",
    },
  },

  // ── Privacy ───────────────────────────────────────────────────────────────
  {
    id: "NEED_PRIVACY",
    category: "privacy",
    icon: "Lock",
    urgent: true,
    text: {
      "en-US": "I need privacy",
      "hi-IN": "मुझे अकेले में बात करनी है",
      "bn-IN": "আমার একা কথা বলতে হবে",
      "ta-IN": "தனியாக பேச வேண்டும்",
      "te-IN": "నేను ఒంటరిగా మాట్లాడాలి",
      "mr-IN": "मला एकट्याने बोलायचे आहे",
      "gu-IN": "મને એકલાં વાત કરવી છે",
      "kn-IN": "ನನಗೆ ಒಂದಾಗಿ ಮಾತನಾಡಬೇಕು",
      "ml-IN": "എനിക്ക് ഒറ്റയ്ക്ക് സംസാരിക്കണം",
      "pa-IN": "ਮੈਨੂੰ ਇਕੱਠੇ ਗੱਲ ਕਰਨੀ ਹੈ",
    },
  },
  {
    id: "CLOSE_DOOR",
    category: "privacy",
    icon: "DoorClosed",
    text: {
      "en-US": "Please close the door",
      "hi-IN": "कृपया दरवाज़ा बंद करें",
      "bn-IN": "দয়া করে দরজা বন্ধ করুন",
      "ta-IN": "கதவை மூடவும்",
      "te-IN": "తలుపు మూసివేయండి",
      "mr-IN": "कृपया दार बंद करा",
      "gu-IN": "કૃપા કરીને બારણું બંધ કરો",
      "kn-IN": "ದಯವಿಟ್ಟು ಬಾಗಿಲು ಮುಚ್ಚಿ",
      "ml-IN": "കയ്വ് അടയ്ക്കാം",
      "pa-IN": "ਕਿਰਪਾ ਕਰਕੇ ਦਰਵਾਜ਼ਾ ਬੰਦ ਕਰੋ",
    },
  },
  {
    id: "STOP_NO",
    category: "privacy",
    icon: "Hand",
    urgent: true,
    text: {
      "en-US": "Stop, please do not",
      "hi-IN": "रुकिए, कृपया ऐसा मत करें",
      "bn-IN": "থামুন, দয়া করে এটি করবেন না",
      "ta-IN": "நிற்குங்கள், தயவுசெய்து செய்யாதீர்கள்",
      "te-IN": "ఆపండి, దయచేసి చేయండి",
      "mr-IN": "थांबा, कृपया असे करू नका",
      "gu-IN": "રસો, કૃપા કરીને આમ ન કરો",
      "kn-IN": "ನಿಲ್ಲಿ, ದಯವಿಟ್ಟು ಮಾಡಬೇಡಿ",
      "ml-IN": "നിർത്തുക, ദയവേട്ട് വേണ്ട",
      "pa-IN": "ਰੋਕੋ, ਕਿਰਪਾ ਕਰਕੇ ਇਹ ਨਾ ਕਰੋ",
    },
  },
  {
    id: "LEAVE_ME",
    category: "privacy",
    icon: "LogOut",
    text: {
      "en-US": "Please leave me alone",
      "hi-IN": "कृपया मुझे अकेला छोड़ दें",
      "bn-IN": "আমাকে একা ছেড়ে দিন",
      "ta-IN": "தயவுசெய்து என்னை தனிமையாக விடுங்கள்",
      "te-IN": "దయచేసి నన్ను ఒంటరిగా వదిలేయండి",
      "mr-IN": "कृपया मला एकट्याने सोडा",
      "gu-IN": "કૃપા કરીને મને એકલું છોડી દો",
      "kn-IN": "ನನ್ನನ್ನು ಒಂದಾಗಿ ಬಿಡುಗಡೆ ಮಾಡಿ",
      "ml-IN": "എന്നെ ഒറ്റയിലായി വിട്ടുപോകാം",
      "pa-IN": "ਕਿਰਪਾ ਕਰਕੇ ਮੈਨੂੰ ਇਕੱਠਾ ਛੱਡ ਦਿਓ",
    },
  },
  {
    id: "IM_FINE",
    category: "privacy",
    icon: "Smile",
    text: {
      "en-US": "I am fine",
      "hi-IN": "मैं ठीक हूँ",
      "bn-IN": "আমি ভালো আছি",
      "ta-IN": "நான் நன்றாக இருக்கிறேன்",
      "te-IN": "నేను బాగున్నాను",
      "mr-IN": "मी ठीक आहे",
      "gu-IN": "હું ઠીક છું",
      "kn-IN": "ನನಗೆ ಸ್ವತ್ತು",
      "ml-IN": "എനിക്ക് സുഖമാണ്",
      "pa-IN": "ਮੈਂ ਠੀਕ ਹਾਂ",
    },
  },
];

const BY_ID = new Map(PHRASES.map((p) => [p.id, p]));

/** Every phrase id, as gesture names the server will accept. */
export const PHRASE_GESTURE_NAMES: ReadonlySet<string> = new Set(PHRASES.map((p) => p.id));

/**
 * The gesture names the ingest/sync layer will persist.
 *
 * This lives here rather than inline in the API route so that the allowlist
 * and the phrase catalogue cannot drift apart: a phrase added to `PHRASES` is
 * accepted automatically, and a rename cannot silently produce a tile that
 * speaks locally and is then dropped before it reaches the nurse.
 */
export const SERVER_GESTURE_NAMES: ReadonlySet<string> = new Set<string>([
  "YES",
  "NO",
  "HELP",
  "WATER",
  "HELLO",
  "EMERGENCY",
  "SYSTEM",
  ...PHRASE_GESTURE_NAMES,
]);

export function phraseById(id: string): Phrase | undefined {
  return BY_ID.get(id);
}

export function phrasesInCategory(category: PhraseCategory): Phrase[] {
  return PHRASES.filter((p) => p.category === category);
}

/**
 * The phrase in the patient's language, never blank.
 *
 * A missing or blank translation falls back to English rather than leaving a
 * tile that selects successfully and says nothing at all — a silent board is
 * the failure mode this whole feature exists to prevent.
 */
export function phraseText(id: string, lang: string): string {
  const phrase = BY_ID.get(id);
  if (!phrase) return "";
  const exact = phrase.text[lang as SupportedLanguage];
  if (exact && exact.trim()) return exact;
  return phrase.text["en-US"];
}
