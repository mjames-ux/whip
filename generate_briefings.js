function renderVotingSection(votes) {
    state.currentVotes = Array.isArray(votes) ? votes : [];

    if (state.currentVotes.length === 0) {
        els.voteCountBadge.textContent = '0 divisions';
        els.votingRecordsList.innerHTML = `<div class="py-6 text-sm text-inkSecondary">No House of Commons division votes were held during this period.</div>`;
        return;
    }

    els.voteCountBadge.textContent = `${state.currentVotes.length} ${state.currentVotes.length === 1 ? 'division' : 'divisions'}`;
    els.votingRecordsList.innerHTML = state.currentVotes.map((v, idx) => {
        const badgeClass = v.mpVote === 'Aye'
            ? 'bg-commonsGreen/10 text-commonsGreen border-commonsGreen/20'
            : v.mpVote === 'No'
                ? 'bg-red-50 text-red-700 border-red-200'
                : 'bg-surfaceSubtle text-inkSecondary border-hairline';
        const badgeLabel = v.mpVote === 'Abstained' ? 'No vote recorded' : `Voted ${v.mpVote}`;

        const exp = v.explainer || {};
        const underlyingSubject = String(exp.underlyingSubject || exp.billSummary || '').trim();
        const amendmentDetails = String(exp.amendmentDetails || '').trim();
        const proposerView = String(exp.proposerView || exp.billAims || exp.statedAims || '').trim();
        const stageText = String(exp.stageAndMeaning || exp.stageSummary || exp.whatItDoes || '').trim();
        const parliamentUrl = String(exp.parliamentUrl || '').trim();

        const hasExplainer = Boolean(underlyingSubject || amendmentDetails || proposerView || stageText);
        const anchorId = v.divisionId ? `vote-${v.divisionId}` : `vote-idx-${idx}`;

        const shareMenuMarkup = `
            <div class="relative inline-block" data-share-container>
                <button type="button" data-vote-share-toggle="${idx}" aria-expanded="false" aria-haspopup="true" class="inline-flex items-center gap-1 text-xs font-medium text-inkSecondary hover:text-ink transition-colors cursor-pointer">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
                        <polyline points="16 6 12 2 8 6"></polyline>
                        <line x1="12" y1="2" x2="12" y2="15"></line>
                    </svg>
                    <span>Share vote</span>
                </button>
                <div data-share-menu data-vote-share-menu="${idx}" class="hidden fixed left-5 right-5 sm:static sm:absolute sm:inset-auto sm:mb-2 sm:w-56 bg-canvas border border-hairline rounded-2xl shadow-xl py-1.5 z-40 text-xs text-left">
                    <p class="px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-inkTertiary">
                        Share MP vote via Whip.
                    </p>
                    <button type="button" data-vote-share-action="${idx}" data-share-channel="native" class="hidden w-full px-3.5 py-2 text-left text-ink hover:bg-surfaceSubtle transition-colors flex items-center justify-between cursor-pointer">
                        <span class="font-medium">More phone options…</span>
                        <span class="text-commonsGreen font-semibold text-[11px]">Share</span>
                    </button>
                    <button type="button" data-vote-share-action="${idx}" data-share-channel="whatsapp" class="w-full px-3.5 py-2 text-left text-ink hover:bg-surfaceSubtle transition-colors flex items-center justify-between cursor-pointer">
                        <span class="font-medium">Share on WhatsApp</span>
                        <span class="text-commonsGreen font-semibold text-[11px]">WA</span>
                    </button>
                    <button type="button" data-vote-share-action="${idx}" data-share-channel="x" class="w-full px-3.5 py-2 text-left text-ink hover:bg-surfaceSubtle transition-colors flex items-center justify-between cursor-pointer">
                        <span class="font-medium">Share on X</span>
                        <span class="text-inkTertiary font-mono text-[11px]">𝕏</span>
                    </button>
                    <button type="button" data-vote-share-action="${idx}" data-share-channel="bluesky" class="w-full px-3.5 py-2 text-left text-ink hover:bg-surfaceSubtle transition-colors flex items-center justify-between cursor-pointer">
                        <span class="font-medium">Share on Bluesky</span>
                        <span class="text-inkTertiary font-medium text-[11px]">🦋</span>
                    </button>
                    <button type="button" data-vote-share-action="${idx}" data-share-channel="threads" class="w-full px-3.5 py-2 text-left text-ink hover:bg-surfaceSubtle transition-colors flex items-center justify-between cursor-pointer">
                        <span class="font-medium">Share on Threads</span>
                        <span class="text-inkTertiary font-semibold text-[11px]">@</span>
                    </button>
                    <button type="button" data-vote-share-action="${idx}" data-share-channel="facebook" class="w-full px-3.5 py-2 text-left text-ink hover:bg-surfaceSubtle transition-colors flex items-center justify-between cursor-pointer">
                        <span class="font-medium">Share on Facebook</span>
                        <span class="text-inkTertiary font-semibold text-[11px]">f</span>
                    </button>
                    <div class="my-1 border-t border-hairline/70"></div>
                    <button type="button" data-vote-share-action="${idx}" data-share-channel="copy" class="w-full px-3.5 py-2 text-left text-ink hover:bg-surfaceSubtle transition-colors flex items-center justify-between cursor-pointer">
                        <span data-copy-label class="font-medium">Copy link</span>
                        <svg class="w-3.5 h-3.5 text-inkTertiary" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        return `
            <div id="${escapeHtmlClient(anchorId)}" class="py-5 scroll-mt-24">
                <button type="button" data-vote-toggle="${idx}" aria-expanded="false" class="w-full text-left flex items-start justify-between gap-3 group cursor-pointer">
                    <div class="min-w-0">
                        <p class="text-sm sm:text-base font-medium text-ink group-hover:text-commonsGreen transition-colors">${escapeHtmlClient(v.title)}</p>
                        <p class="text-xs text-inkTertiary mt-1 flex flex-wrap items-center gap-x-2">
                            <span>${escapeHtmlClient(v.houseResult || '')}${v.sittingDateLabel ? ` &middot; ${escapeHtmlClient(v.sittingDateLabel)}` : ''}</span>
                            ${hasExplainer ? `<span class="text-commonsGreen font-medium inline-flex items-center gap-0.5"><span data-vote-hint="${idx}">Explain vote</span> <svg data-vote-chevron="${idx}" class="w-3 h-3 transition-transform" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"></polyline></svg></span>` : ''}
                        </p>
                    </div>
                    <span class="px-3 py-1 rounded-full text-xs font-medium border shrink-0 ${badgeClass}">
                        ${escapeHtmlClient(badgeLabel)}
                    </span>
                </button>

                ${hasExplainer ? `
                    <div data-vote-panel="${idx}" class="hidden mt-3.5 p-4 sm:p-5 rounded-xl bg-surfaceSubtle border border-hairline/80 space-y-3 text-xs sm:text-sm text-inkSecondary leading-relaxed">
                        ${underlyingSubject ? `<p><strong class="font-semibold text-ink">What this is about:</strong> ${escapeHtmlClient(underlyingSubject)}</p>` : ''}
                        ${amendmentDetails ? `<p><strong class="font-semibold text-ink">The amendment being voted on:</strong> ${escapeHtmlClient(amendmentDetails)}</p>` : ''}
                        ${proposerView ? `<p class="text-ink"><strong class="font-semibold text-ink">Why it is being put forward:</strong> ${escapeHtmlClient(proposerView)}</p>` : ''}
                        ${stageText ? `<p><strong class="font-semibold text-ink">Stage in Parliament &amp; what it means:</strong> ${escapeHtmlClient(stageText)}</p>` : ''}
                        <div class="pt-1.5 flex flex-wrap items-center justify-between gap-3 border-t border-hairline/60">
                            ${parliamentUrl ? `<a href="${escapeHtmlClient(parliamentUrl)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-xs font-medium text-commonsGreen hover:underline">View official Commons division record &rarr;</a>` : '<span></span>'}
                            ${shareMenuMarkup}
                        </div>
                    </div>
                ` : `
                    <div class="mt-2 flex justify-end">
                        ${shareMenuMarkup}
                    </div>
                `}
            </div>
        `;
    }).join('');

    syncNativeShareButtonsVisibility();

    els.votingRecordsList.querySelectorAll('button[data-vote-toggle]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = btn.getAttribute('data-vote-toggle');
            const panel = els.votingRecordsList.querySelector(`[data-vote-panel="${idx}"]`);
            const chevron = els.votingRecordsList.querySelector(`[data-vote-chevron="${idx}"]`);
            const hint = els.votingRecordsList.querySelector(`[data-vote-hint="${idx}"]`);
            if (!panel) return;

            const isOpen = !panel.classList.contains('hidden');
            panel.classList.toggle('hidden', isOpen);
            btn.setAttribute('aria-expanded', String(!isOpen));
            if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
            if (hint) hint.textContent = isOpen ? 'Explain vote' : 'Hide explainer';
        });
    });

    els.votingRecordsList.querySelectorAll('button[data-vote-share-toggle]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = btn.getAttribute('data-vote-share-toggle');
            const menu = els.votingRecordsList.querySelector(`[data-vote-share-menu="${idx}"]`);
            if (!menu) return;
            const willOpen = menu.classList.contains('hidden');
            closeAllShareMenus(menu);
            menu.classList.toggle('hidden', !willOpen);
            btn.setAttribute('aria-expanded', String(willOpen));
        });
    });

    els.votingRecordsList.querySelectorAll('button[data-vote-share-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const idx = Number(btn.getAttribute('data-vote-share-action'));
            const channel = btn.getAttribute('data-share-channel');
            const vote = state.currentVotes[idx];
            const menu = els.votingRecordsList.querySelector(`[data-vote-share-menu="${idx}"]`);
            const trigger = els.votingRecordsList.querySelector(`[data-vote-share-toggle="${idx}"]`);
            const copyLabel = btn.querySelector('[data-copy-label]');
            await executeShareAction(channel, buildVoteSharePayload(vote, idx), copyLabel, menu, trigger);
        });
    });
}
