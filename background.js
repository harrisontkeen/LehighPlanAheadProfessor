// LehighRMP Background Script - Adapted from WesternRMP
// Fetches RateMyProfessors data here (not in the page) to avoid CORS.

const GRAPHQL_URL = 'https://www.ratemyprofessors.com/graphql';
const LEHIGH_SCHOOL_ID = btoa('School-509'); // Lehigh University's RMP ID
const AUTH_TOKEN = 'Basic dGVzdDp0ZXN0';
const CACHE_TTL_MS = 30 * 60 * 1000;

const SEARCH_QUERY = `query NewSearchTeachersQuery($query: TeacherSearchQuery!) {
    newSearch {
        teachers(query: $query) {
            didFallback
            edges {
                node {
                    id
                    legacyId
                    firstName
                    lastName
                    avgRatingRounded
                    numRatings
                    wouldTakeAgainPercentRounded
                    wouldTakeAgainCount
                    teacherRatingTags {
                        tagCount
                        tagName
                    }
                    mostUsefulRating {
                        class
                        comment
                        date
                        qualityRating
                    }
                    avgDifficultyRounded
                    school {
                        name
                        id
                    }
                    department
                }
            }
        }
    }
}`;

// Banner shows "Last, First Middle (Primary)". RMP searches best with "First Last".
const parseBannerName = (rawName) => {
    const cleaned = (rawName || '').replace(/\(primary\)/i, '').replace(/\s+/g, ' ').trim();
    if (cleaned.includes(',')) {
        const [last, rest = ''] = cleaned.split(',').map(s => s.trim());
        const first = rest.split(' ').filter(Boolean)[0] || '';
        return { first, last };
    }
    const parts = cleaned.split(' ').filter(Boolean);
    return { first: parts[0] || '', last: parts.slice(1).join(' ') };
};

const normalize = (s) => (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z' -]/g, '')
    .trim();

const firstNameMatches = (searchFirst, profFirst) => {
    if (!searchFirst || !profFirst) return false;
    return profFirst === searchFirst ||
        profFirst.startsWith(searchFirst) ||
        searchFirst.startsWith(profFirst);
};

const lastNameMatches = (searchLast, profLast) => {
    if (!searchLast || !profLast) return false;
    if (profLast === searchLast) return true;
    // Hyphenated or multi-part last names: any shared part counts.
    const searchParts = searchLast.split(/[\s-]+/).filter(p => p.length > 1);
    const profParts = profLast.split(/[\s-]+/).filter(p => p.length > 1);
    return searchParts.some(p => profParts.includes(p));
};

const pickBestMatch = (edges, { first, last }, department) => {
    const searchFirst = normalize(first);
    const searchLast = normalize(last);

    const matches = edges
        .map(e => e.node)
        .filter(n => n && n.school && n.school.id === LEHIGH_SCHOOL_ID)
        .filter(n => lastNameMatches(searchLast, normalize(n.lastName)) &&
                     firstNameMatches(searchFirst, normalize(n.firstName)));

    if (matches.length <= 1) return matches[0] || null;

    // Several candidates: prefer the department match, then the most-rated profile.
    const dept = normalize(department);
    if (dept) {
        const deptMatch = matches.find(n => {
            const d = normalize(n.department);
            return d && (d.includes(dept) || dept.includes(d));
        });
        if (deptMatch) return deptMatch;
    }
    return matches.sort((a, b) => (b.numRatings || 0) - (a.numRatings || 0))[0];
};

const runSearch = async (text) => {
    const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': AUTH_TOKEN,
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            query: SEARCH_QUERY,
            variables: { query: { text, schoolID: LEHIGH_SCHOOL_ID } }
        })
    });
    if (!response.ok) {
        throw new Error(`RateMyProfessors request failed with status ${response.status}`);
    }
    const json = await response.json();
    if (json.errors && json.errors.length) {
        throw new Error(`RateMyProfessors error: ${json.errors[0].message}`);
    }
    return json?.data?.newSearch?.teachers?.edges || [];
};

const searchProfessor = async (professorName, department) => {
    const name = parseBannerName(professorName);
    if (!name.first || !name.last) return null;

    let match = pickBestMatch(await runSearch(`${name.first} ${name.last}`), name, department);
    if (!match) {
        // RMP may list a nickname ("Bob" for "Robert"): retry on last name alone,
        // and accept only a single same-initial result.
        const edges = await runSearch(name.last);
        const candidates = edges
            .map(e => e.node)
            .filter(n => n && n.school && n.school.id === LEHIGH_SCHOOL_ID)
            .filter(n => normalize(n.lastName) === normalize(name.last) &&
                         normalize(n.firstName)[0] === normalize(name.first)[0]);
        if (candidates.length === 1) match = candidates[0];
    }
    return match;
};

// Cache by name so a results page with 50 sections doesn't fire 50 identical requests.
const cache = new Map();

const cachedSearch = (professorName, department) => {
    const key = `${professorName}|${department || ''}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.promise;

    const promise = searchProfessor(professorName, department);
    cache.set(key, { time: Date.now(), promise });
    promise.catch(() => cache.delete(key)); // don't cache network failures
    return promise;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== 'searchProfessor') return false;

    const { professorName, department } = message;
    if (!professorName) {
        sendResponse({ success: false, error: 'Professor name is required' });
        return false;
    }

    cachedSearch(professorName, department)
        .then(professor => {
            if (professor) {
                sendResponse({ success: true, professor: { node: professor } });
            } else {
                sendResponse({ success: false, notFound: true, error: 'Professor not found' });
            }
        })
        .catch(error => {
            console.error(`LehighRMP: lookup failed for ${professorName}:`, error);
            sendResponse({ success: false, error: error.message });
        });

    return true; // respond asynchronously
});
