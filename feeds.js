// News Stack v3 (PWA) — feeds, topics and the constants that rank them.
//
// Ported verbatim from app.py. Every value here is the value v3 uses; the
// comments explaining why a number is what it is are kept, because they are
// the reason not to "tidy" them later.

// The arXiv RSS feeds carry only the current day's announcements and are empty
// at weekends and holidays. The Atom API returns the latest submissions whatever
// the day, so these categories stop going idle for two days out of seven.
const ARXIV = (cat) =>
  "https://export.arxiv.org/api/query?search_query=cat:" + cat +
  "&sortBy=submittedDate&sortOrder=descending&max_results=40";

// --------------------------------------------------------------------------
// Feeds. Every entry below was reachability-tested before being included.
// --------------------------------------------------------------------------
const FEEDS = {
  "AI": [
    ["OpenAI", "https://openai.com/news/rss.xml"],
    ["Google AI", "https://blog.google/technology/ai/rss/"],
    ["DeepMind", "https://deepmind.google/blog/rss.xml"],
    ["Hugging Face", "https://huggingface.co/blog/feed.xml"],
    ["Berkeley AI", "https://bair.berkeley.edu/blog/feed.xml"],
    ["MIT AI", "https://news.mit.edu/rss/topic/artificial-intelligence2"],
    ["Import AI", "https://importai.substack.com/feed"],
  ],
  "AI RESEARCH": [
    ["arXiv AI", ARXIV("cs.AI")],
    ["arXiv ML", ARXIV("cs.LG")],
    ["arXiv Language", ARXIV("cs.CL")],
  ],
  "TECHNOLOGY": [
    ["Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"],
    ["The Verge", "https://www.theverge.com/rss/index.xml"],
    ["TechCrunch", "https://techcrunch.com/feed/"],
    ["IEEE Spectrum", "https://spectrum.ieee.org/feeds/feed.rss"],
    ["Hacker News", "https://news.ycombinator.com/rss"],
    ["BBC Technology", "https://feeds.bbci.co.uk/news/technology/rss.xml"],
  ],
  "CYBERSECURITY": [
    ["Krebs on Security", "https://krebsonsecurity.com/feed/"],
    ["BleepingComputer", "https://www.bleepingcomputer.com/feed/"],
    ["The Hacker News", "https://feeds.feedburner.com/TheHackersNews"],
    ["Schneier", "https://www.schneier.com/feed/"],
    // CISA's edge fingerprints TLS, not headers. In v3 this feed worked from
    // the container and 403ed from Windows Python. Through the worker it is
    // Cloudflare's TLS stack talking to it, which is the working case.
    ["CISA", "https://www.cisa.gov/cybersecurity-advisories/all.xml"],
    ["arXiv Crypto/Sec", ARXIV("cs.CR")],
  ],
  "PROGRAMMING": [
    ["Lobsters", "https://lobste.rs/rss"],
    ["Rust Blog", "https://blog.rust-lang.org/feed.xml"],
    ["Go Blog", "https://go.dev/blog/feed.atom"],
    ["Python Insider", "https://blog.python.org/feeds/posts/default"],
    ["Stack Overflow", "https://stackoverflow.blog/feed/"],
  ],
  "OPEN SOURCE": [
    ["LWN", "https://lwn.net/headlines/rss"],
    ["Phoronix", "https://www.phoronix.com/rss.php"],
    ["GitHub Blog", "https://github.blog/feed/"],
  ],
  "ASTRONOMY": [
    ["NASA", "https://www.nasa.gov/rss/dyn/breaking_news.rss"],
    ["NASA Science", "https://science.nasa.gov/feed/"],
    ["JPL", "https://www.jpl.nasa.gov/feeds/news/"],
    ["ESA", "https://www.esa.int/rssfeed/Our_Activities/Space_Science"],
    ["Hubble", "https://esahubble.org/rss/feed.xml"],
    ["SpaceNews", "https://spacenews.com/feed/"],
    ["Sky & Telescope", "https://skyandtelescope.org/feed/"],
    ["APOD", "https://apod.nasa.gov/apod.rss"],
  ],
  "COSMOLOGY & PHYSICS": [
    ["arXiv Cosmology", ARXIV("astro-ph.CO")],
    ["arXiv High Energy", ARXIV("astro-ph.HE")],
    ["arXiv Relativity", ARXIV("gr-qc")],
    ["Quanta", "https://www.quantamagazine.org/feed/"],
    ["Fermilab", "https://news.fnal.gov/feed/"],
    ["Physics World", "https://physicsworld.com/feed/"],
  ],
  "SCIENCE": [
    ["Nature", "https://www.nature.com/nature.rss"],
    ["Science", "https://www.science.org/rss/news_current.xml"],
    ["Scientific American", "https://www.scientificamerican.com/platform/syndication/rss/"],
    ["ScienceDaily", "https://www.sciencedaily.com/rss/top/science.xml"],
    ["Phys.org", "https://phys.org/rss-feed/"],
  ],
  "REDDIT": [
    ["r/technology", "https://www.reddit.com/r/technology/.rss"],
    ["r/artificial", "https://www.reddit.com/r/artificial/.rss"],
    ["r/MachineLearning", "https://www.reddit.com/r/MachineLearning/.rss"],
    ["r/programming", "https://www.reddit.com/r/programming/.rss"],
    ["r/netsec", "https://www.reddit.com/r/netsec/.rss"],
    ["r/opensource", "https://www.reddit.com/r/opensource/.rss"],
    ["r/space", "https://www.reddit.com/r/space/.rss"],
    ["r/physics", "https://www.reddit.com/r/physics/.rss"],
    ["r/science", "https://www.reddit.com/r/science/.rss"],
    ["r/worldnews", "https://www.reddit.com/r/worldnews/.rss"],
  ],
  "GITHUB": [
    ["openai-python", "https://github.com/openai/openai-python/releases.atom"],
    ["ollama", "https://github.com/ollama/ollama/releases.atom"],
    ["langchain", "https://github.com/langchain-ai/langchain/releases.atom"],
    ["llama_index", "https://github.com/run-llama/llama_index/releases.atom"],
    ["vllm", "https://github.com/vllm-project/vllm/releases.atom"],
    ["pytorch", "https://github.com/pytorch/pytorch/releases.atom"],
    ["transformers", "https://github.com/huggingface/transformers/releases.atom"],
    ["kubernetes", "https://github.com/kubernetes/kubernetes/releases.atom"],
    ["rust", "https://github.com/rust-lang/rust/releases.atom"],
  ],
  "GENERAL": [
    ["BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"],
    ["NPR", "https://feeds.npr.org/1001/rss.xml"],
  ],
};

// Feeds that are discovery signals rather than reporting.
const DISCOVERY = { "REDDIT": 2.0, "GITHUB": 1.5, "AI RESEARCH": 1.0 };

// Hosts that punish rapid sequential requests. Seconds between requests.
// Still enforced here even though the worker makes the real request: the
// worker is one IP for every reader, so spacing has to start at this end.
const HOST_INTERVAL = { "www.reddit.com": 30.0, "export.arxiv.org": 3.0, "github.com": 0.7 };
const DEFAULT_HOST_INTERVAL = 0.25;

// Categories fetched a slice at a time, rotating across cycles. Reddit's limit
// on public .rss is per-IP and tighter than any spacing can work around; one
// per cycle sweeps all ten subreddits every 50 minutes.
const ROTATION = { "REDDIT": 1 };

// First path segment of a GitHub tag that means "CI ran", not "we shipped".
const CI_TAG_PREFIXES = new Set(["ciflow", "trunk", "nightly", "viable", "main", "master"]);

// Title-similarity threshold for merging two stories into one cluster.
//
// 0.42 was measured against 1247 stories and was right for titles compared
// whole. Re-measured against 1195 stories with dates removed from the
// comparison, it is too strict: 11 cross-source clusters where 0.30 finds 23,
// and every one of the extra 12 is a real match. 0.26 reaches 31 and starts
// merging unrelated arXiv papers, so 0.30 is the floor, not a midpoint.
const MERGE_JACCARD = 0.30;
const MERGE_WINDOW_S = 7 * 86400;

// Dates in a headline are never what a story is about. APOD publishes
// "APOD: 2026 August 8 - ..." daily and r/physics publishes a weekly thread
// with the date in it: both families merged on nothing but shared date tokens.
const MERGE_MONTHS = new Set(`
january february march april may june july august september october november
december jan feb mar apr jun jul aug sep sept oct nov dec
`.trim().split(/\s+/));
const MERGE_DATE = /^(?:\d+(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2})$/;

const KEYWORDS = [
  "agent", "ai", "algorithm", "benchmark", "breach", "cosmology", "cve", "dark energy",
  "dark matter", "discovery", "exploit", "gpu", "gravitational", "inference", "jwst",
  "kernel", "launch", "llm", "malware", "model", "neutrino", "open source", "physics",
  "quantum", "ransomware", "release", "research", "security", "telescope",
  "transformer", "vulnerability",
];

const STOPWORDS = new Set(`
a about after against all also an and any are as at be been before being between both but by
can could did do does doing down during each few for from further had has have having he her
here hers him his how i if in into is it its just me more most my new no nor not now of off on
once only or other our out over own same she should so some such than that the their them then
there these they this those through to too under until up very was we were what when where
which while who whom why will with would you your says say said new report reports
`.trim().split(/\s+/));

// Topics derived from what a story is about, not from which feed carried it.
// A SpaceX launch arrives via TechCrunch under TECHNOLOGY, but a reader looking
// under ASTRONOMY expects to find it. Every story keeps its feed category and
// gains any topic it matches, so it appears under all of them.
const TOPIC_WORDS = {
  // Words dropped after spot-checking real output: "launch" and "probe" tag
  // product announcements, "plasma" filed KDE Plasma under physics, "titan"
  // and "europa" are company names as often as moons, "inflation" is usually
  // economics. Precision beats reach when a wrong topic is a wrong tab.
  "ASTRONOMY": `spacex starship falcon rocket launcher booster satellite
    satellites orbit orbital spacecraft rover lander telescope observatory
    nasa esa jaxa isro roscosmos jpl artemis apollo iss mars martian lunar
    asteroid comet meteor eclipse exoplanet
    astronaut cosmonaut spaceflight payload deorbit reentry constellation
    starlink kuiper blue-origin rocketlab ula soyuz hubble jwst webb`,
  "COSMOLOGY & PHYSICS": `cosmology cosmological universe cosmos galaxy galaxies
    nebula quasar pulsar supernova neutron black-hole singularity relativity
    gravitational gravity spacetime dark-matter dark-energy redshift
    bigbang entanglement qubit superconductor collider cern
    lhc higgs boson neutrino quark fermion photon thermodynamics
    antimatter physics physicist astrophysics`,
  "SCIENCE": `research researchers study studies scientist scientists discovery
    experiment experimental journal peer-reviewed climate biology biological
    genome genetic dna rna protein species evolution fossil ecology chemistry
    chemical molecule neuroscience medicine clinical trial vaccine`,
  "AI": `ai artificial-intelligence llm llms model models neural transformer
    gpt claude gemini llama mistral inference training fine-tuning embedding
    openai anthropic deepmind huggingface agent agents chatbot machine-learning
    deeplearning benchmark rag multimodal diffusion`,
  "CYBERSECURITY": `vulnerability vulnerabilities exploit exploited malware
    ransomware breach breached phishing cve zero-day backdoor botnet spyware
    credential attacker hacker intrusion patch infosec encryption cryptography`,
  "PROGRAMMING": `python rust golang javascript typescript compiler runtime
    kernel api sdk library framework refactor debugging repository git linux
    database sql container kubernetes devops open-source`,
  "TECHNOLOGY": `chip chips semiconductor fab foundry gpu cpu tsmc nvidia intel
    amd data-center datacenter cloud hardware smartphone processor bandwidth
    battery robotics chipmaker`,
};

// A story needs this many distinct matches before a topic is added, so one
// passing mention of "model" does not file a phone review under AI.
const TOPIC_MIN_HITS = 2;

const RE_ESCAPE = /[.*+?^${}()|[\]\\-]/g;

/**
 * Build one topic's matcher.
 *
 * Python does `re.escape(term).replace(r"\-", "[- ]?")`, so "dark-matter" also
 * matches "dark matter" and "darkmatter". Longest terms first so "black-hole"
 * is tried before "hole" would be.
 *
 * The leading `(^|[^a-z0-9])` is a capture group rather than a lookbehind:
 * lookbehind is fine on current iOS but costs nothing to avoid, and the group
 * lets the scan step past the separator without skipping an adjacent term.
 */
function topicPattern(words) {
  const terms = [...new Set(words.trim().split(/\s+/))].sort((a, b) => b.length - a.length);
  const alts = terms
    .map((t) => t.replace(RE_ESCAPE, "\\$&").replace(/\\-/g, "[- ]?"))
    .join("|");
  return new RegExp("(^|[^a-z0-9])((?:" + alts + "))(?![a-z0-9])", "gi");
}

const TOPIC_PATTERNS = Object.fromEntries(
  Object.entries(TOPIC_WORDS).map(([name, words]) => [name, topicPattern(words)])
);

/** Every distinct term of `pattern` found in `text`, lowercased. */
function topicHits(pattern, text) {
  pattern.lastIndex = 0;
  const found = new Set();
  let m;
  while ((m = pattern.exec(text)) !== null) {
    found.add(m[2].toLowerCase());
    // Step back over the separator so two adjacent terms both match.
    pattern.lastIndex = m.index + m[0].length;
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return found;
}

/** Topics this story belongs to, always including its own feed category. */
function topicsFor(title, summary, category) {
  const found = new Set([category]);
  const blob = title + " " + (summary || "");
  for (const [name, pattern] of Object.entries(TOPIC_PATTERNS)) {
    // The title is the strongest signal: one match there is enough.
    if (topicHits(pattern, blob).size >= TOPIC_MIN_HITS || topicHits(pattern, title).size > 0) {
      found.add(name);
    }
  }
  return "|" + [...found].sort().join("|") + "|";
}

window.NEWSSTACK_FEEDS = {
  FEEDS, DISCOVERY, HOST_INTERVAL, DEFAULT_HOST_INTERVAL, ROTATION,
  CI_TAG_PREFIXES, MERGE_JACCARD, MERGE_WINDOW_S, MERGE_MONTHS, MERGE_DATE,
  KEYWORDS, STOPWORDS, TOPIC_MIN_HITS, topicsFor,
};
