// LehighRMP Content Script - Adapted from WesternRMP
// Adds a RateMyProfessors badge next to each instructor in Banner's results grids
// (Plan Ahead, Browse Classes, Register for Classes).

const INSTRUCTOR_SELECTOR = 'td[xe-field="instructor"]';
const BADGE_CLASS = 'lehighrmp-rating-badge';
const TOOLTIP_ID = 'lehighrmp-tooltip';

const processed = new WeakSet();   // instructor links/cells already handled
const lookups = new Map();         // name -> Promise<professor|null>

const escapeHTML = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function cleanName(raw) {
    return (raw || '').replace(/\(primary\)/i, '').replace(/\s+/g, ' ').trim();
}

function isValidProfessorName(name) {
    const lower = name.toLowerCase();
    if (lower.length < 3 || lower.length > 60) return false;
    if (/\b(staff|tba|teaching staff|instructor)\b/.test(lower)) return false;
    if (!lower.includes(',') && !lower.includes(' ')) return false;
    return /^[\p{L}\s,.'’-]+$/u.test(name);
}

// Returns [{ key, name }] where key is the element we mark as processed.
function extractInstructors(cell) {
    const links = [...cell.querySelectorAll('a')];
    if (links.length > 0) {
        return links
            .map(link => ({ key: link, name: cleanName(link.textContent) }))
            .filter(({ name }) => isValidProfessorName(name));
    }
    const name = cleanName(cell.textContent);
    return isValidProfessorName(name) ? [{ key: cell, name }] : [];
}

function extractSubject(cell) {
    const row = cell.closest('tr');
    const subject = row && row.querySelector('td[xe-field="subject"]');
    return subject ? subject.textContent.trim() : '';
}

function lookupProfessor(name, department) {
    const key = name.toLowerCase();
    if (!lookups.has(key)) {
        const promise = new Promise(resolve => {
            try {
                chrome.runtime.sendMessage({ action: 'searchProfessor', professorName: name, department }, response => {
                    if (chrome.runtime.lastError) {
                        console.warn('LehighRMP:', chrome.runtime.lastError.message);
                        lookups.delete(key);
                        resolve(null);
                        return;
                    }
                    if (response?.success) {
                        resolve(response.professor.node);
                    } else {
                        if (!response?.notFound) lookups.delete(key); // let a re-rendered row retry
                        resolve(null);
                    }
                });
            } catch (error) {
                // Extension was reloaded/updated while this page was open.
                lookups.delete(key);
                resolve(null);
            }
        });
        lookups.set(key, promise);
    }
    return lookups.get(key);
}

function formatNumber(value, numRatings) {
    return typeof value === 'number' && value > 0 && numRatings > 0 ? value.toFixed(1) : 'N/A';
}

function getRatingColor(rating) {
    const r = parseFloat(rating);
    if (isNaN(r)) return '#999';
    if (r >= 4.5) return '#4CAF50';
    if (r >= 3.5) return '#8BC34A';
    if (r >= 2.5) return '#FFC107';
    if (r >= 1.5) return '#FF9800';
    return '#F44336';
}

function profileUrl(prof) {
    return `https://www.ratemyprofessors.com/professor/${encodeURIComponent(prof.legacyId)}`;
}

function buildTooltipHTML(prof, fallbackDepartment) {
    const numRatings = prof.numRatings || 0;
    const avgRating = formatNumber(prof.avgRatingRounded, numRatings);
    const avgDifficulty = formatNumber(prof.avgDifficultyRounded, numRatings);
    const wta = prof.wouldTakeAgainPercentRounded;
    const wouldTakeAgain = typeof wta === 'number' && wta >= 0 ? `${wta.toFixed(1)}%` : 'N/A';
    const department = prof.department || fallbackDepartment || 'N/A';

    let tagsHTML = '';
    if (Array.isArray(prof.teacherRatingTags) && prof.teacherRatingTags.length > 0) {
        const topTags = [...prof.teacherRatingTags]
            .sort((a, b) => b.tagCount - a.tagCount)
            .slice(0, 3)
            .map(tag => escapeHTML(tag.tagName))
            .join(', ');
        tagsHTML = `<p style="margin:0 0 8px 0; font-size:11px;"><strong>Top Tags:</strong> ${topTags}</p>`;
    }

    let helpfulHTML = '<p style="margin:0; font-size:11px;">No reviews yet</p>';
    const rating = prof.mostUsefulRating;
    if (rating) {
        const parsedDate = rating.date ? new Date(rating.date.replace(' +0000 UTC', 'Z').replace(' ', 'T')) : null;
        const date = parsedDate && !isNaN(parsedDate) ? parsedDate.toLocaleDateString() : 'Unknown date';
        const comment = rating.comment || 'No comment provided';
        const shortComment = comment.length > 160 ? `${comment.substring(0, 160)}...` : comment;
        helpfulHTML = `
            <p style="margin:0 0 5px 0; font-size:11px;"><strong>Course:</strong> ${escapeHTML(rating.class || 'Unknown course')}</p>
            <p style="margin:0 0 5px 0; font-size:11px;"><strong>Rating:</strong> ${escapeHTML(rating.qualityRating ?? 'N/A')}/5 (${escapeHTML(date)})</p>
            <p style="margin:0; font-size:11px;"><strong>Comment:</strong> "${escapeHTML(shortComment)}"</p>
        `;
    }

    return `
        <div style="border-bottom:1px solid #ddd; margin-bottom:8px; padding-bottom:8px;">
            <p style="margin:0 0 3px 0; font-size:13px; font-weight:bold; color:#1976D2;">${escapeHTML(`${prof.firstName} ${prof.lastName}`.trim())}</p>
            <p style="margin:0; font-size:11px; color:#666;">${escapeHTML(department)}</p>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid #eee;">
            <div style="text-align:center;">
                <p style="margin:0; font-size:10px; color:#999;">Quality</p>
                <p style="margin:3px 0 0 0; font-size:16px; font-weight:bold; color:#2196F3;">${avgRating}/5</p>
            </div>
            <div style="text-align:center;">
                <p style="margin:0; font-size:10px; color:#999;">Difficulty</p>
                <p style="margin:3px 0 0 0; font-size:16px; font-weight:bold; color:#FF9800;">${avgDifficulty}/5</p>
            </div>
        </div>
        <div style="margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid #eee;">
            <p style="margin:0; font-size:11px;"><strong>Would Take Again:</strong> ${wouldTakeAgain}</p>
            <p style="margin:3px 0 0 0; font-size:11px;"><strong>Number of Ratings:</strong> ${numRatings}</p>
        </div>
        ${tagsHTML}
        <div>
            <p style="margin:0 0 5px 0; font-size:11px; font-weight:bold;">Most Helpful:</p>
            ${helpfulHTML}
        </div>
        <div style="margin-top:8px; padding-top:8px; border-top:1px solid #eee; text-align:center;">
            <a href="${profileUrl(prof)}" target="_blank" rel="noopener noreferrer" style="color:#1976D2; font-size:11px; text-decoration:none;">View on RateMyProfessors</a>
            <p style="margin:4px 0 0 0; font-size:10px; color:#999;">Data from RateMyProfessors.com</p>
        </div>
    `;
}

// One shared tooltip for the whole page.
let tooltip = null;
let hideTimer = null;

function getTooltip() {
    if (tooltip && document.body.contains(tooltip)) return tooltip;
    tooltip = document.createElement('div');
    tooltip.id = TOOLTIP_ID;
    tooltip.style.cssText = `
        display: none;
        position: fixed;
        z-index: 999999;
        background-color: white;
        border: 1px solid #999;
        border-radius: 4px;
        padding: 10px;
        width: 350px;
        max-width: calc(100vw - 20px);
        max-height: 400px;
        box-sizing: border-box;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        font-family: Arial, sans-serif;
        font-size: 12px;
        line-height: 1.4;
        color: #333;
        overflow-y: auto;
        text-align: left;
    `;
    tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    tooltip.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(tooltip);
    return tooltip;
}

function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (tooltip) tooltip.style.display = 'none'; }, 250);
}

function showTooltip(badge, html) {
    clearTimeout(hideTimer);
    const tip = getTooltip();
    tip.innerHTML = html;
    tip.style.visibility = 'hidden';
    tip.style.display = 'block';

    const rect = badge.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const gap = 6;

    let top = rect.top - height - gap;               // above the badge
    if (top < 10) top = rect.bottom + gap;           // no room: below it
    top = Math.max(10, Math.min(top, window.innerHeight - height - 10));
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - width - 10));

    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    tip.style.visibility = 'visible';
}

function createBadge(prof, department) {
    const numRatings = prof.numRatings || 0;
    const avgRating = formatNumber(prof.avgRatingRounded, numRatings);

    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = avgRating;
    badge.setAttribute('role', 'link');
    badge.setAttribute('aria-label', `RateMyProfessors rating for ${prof.firstName} ${prof.lastName}: ${avgRating} out of 5`);
    badge.style.cssText = `
        background-color: ${getRatingColor(avgRating)};
        color: white;
        padding: 2px 4px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: bold;
        margin-left: 5px;
        cursor: pointer;
        display: inline-block;
    `;

    const html = buildTooltipHTML(prof, department);
    badge.addEventListener('mouseenter', () => showTooltip(badge, html));
    badge.addEventListener('mouseleave', scheduleHide);
    badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(profileUrl(prof), '_blank', 'noopener');
    });
    return badge;
}

async function addRating(cell, key, name) {
    const department = extractSubject(cell);
    const prof = await lookupProfessor(name, department);
    // Not on RMP: leave the name as-is.
    if (!prof) return;
    // Banner may have re-rendered the row while we waited.
    if (!cell.isConnected || !cell.contains(key)) return;
    cell.appendChild(createBadge(prof, department));
}

function scanPageForProfessors() {
    document.querySelectorAll(INSTRUCTOR_SELECTOR).forEach(cell => {
        extractInstructors(cell).forEach(({ key, name }) => {
            if (processed.has(key)) return;
            processed.add(key);
            addRating(cell, key, name);
        });
    });
}

let scanTimer = null;
function scheduleScan(delay = 300) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPageForProfessors, delay);
}

const isOwnNode = (node) =>
    node.nodeType === Node.ELEMENT_NODE &&
    (node.classList.contains(BADGE_CLASS) || node.id === TOOLTIP_ID);

const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
        if (tooltip && tooltip.contains(mutation.target)) continue;
        for (const node of mutation.addedNodes) {
            if (!isOwnNode(node) && (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE)) {
                scheduleScan();
                return;
            }
        }
    }
});

observer.observe(document.body, { childList: true, subtree: true });
scheduleScan(100);
