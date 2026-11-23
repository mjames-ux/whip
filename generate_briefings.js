async function fetchWrittenQuestionsPage(params) {
    const items = [];
    let skip = 0;
    const take = 100;

    while (true) {
        const url = new URL(WRITTEN_QUESTIONS_API);
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, String(v));
        }
        url.searchParams.set('house', 'Commons');
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('take', String(take));

        let data;
        try {
            data = await fetchJsonWithTimeout(url.toString(), 30000);
        } catch (err) {
            console.warn(`Written Questions fetch warning at skip=${skip}: ${err.message}`);
            break;
        }

        const results = data?.results || data?.Results || [];
        if (results.length === 0) break;

        items.push(...results);
        skip += results.length;
        const total = data?.totalResults ?? data?.TotalResults ?? 0;
        if (skip >= total) break;
    }

    return items;
}

async function fetchWrittenQuestionsForDate(dateStr) {
    const byMember = new Map();

    const [tabledItems, answeredItems] = await Promise.all([
        fetchWrittenQuestionsPage({ tabledWhenFrom: dateStr, tabledWhenTo: dateStr }),
        fetchWrittenQuestionsPage({ answeredWhenFrom: dateStr, answeredWhenTo: dateStr })
    ]);

    const seenKeys = new Set();

    function pushQuestionRecord(memberId, direction, record) {
        if (!memberId) return;
        const dedupeKey = `${memberId}|${direction}|${record.id || record.uin}`;
        if (seenKeys.has(dedupeKey)) return;
        seenKeys.add(dedupeKey);

        if (!byMember.has(memberId)) {
            byMember.set(memberId, []);
        }
        byMember.get(memberId).push({ direction, ...record });
    }

    for (const item of tabledItems) {
        const val = item?.value || item;
        const askingMemberId = Number(val?.askingMemberId ?? val?.AskingMemberId);
        const uin = val?.uin ?? val?.Uin ?? '';
        const tabledDate = val?.dateTabled ? String(val.dateTabled).slice(0, 10) : dateStr;
        const department = val?.answeringBodyName ?? val?.answeringBody?.name ?? 'Government Department';
        const heading = stripHtml(val?.heading ?? 'Written Parliamentary Question');
        const questionText = stripHtml(val?.questionText ?? '');
        const answerText = stripHtml(val?.answerText ?? '');

        pushQuestionRecord(askingMemberId, 'asked', {
            id: val?.id,
            uin,
            department,
            heading,
            questionText: extractCleanExcerpt(questionText, 500) || questionText,
            answerText: answerText ? (extractCleanExcerpt(answerText, 650) || answerText) : null,
            dateAnswered: val?.dateAnswered ? String(val.dateAnswered).slice(0, 10) : null,
            url: uin
                ? `https://questions-statements.parliament.uk/written-questions/detail/${tabledDate}/${encodeURIComponent(uin)}`
                : 'https://questions-statements.parliament.uk/'
        });
    }

    for (const item of answeredItems) {
        const val = item?.value || item;
        const answeringMemberId = Number(val?.answeringMemberId ?? val?.AnsweringMemberId);
        const uin = val?.uin ?? val?.Uin ?? '';
        const tabledDate = val?.dateTabled ? String(val.dateTabled).slice(0, 10) : dateStr;
        const department = val?.answeringBodyName ?? val?.answeringBody?.name ?? 'Government Department';
        const askingMemberName = stripHtml(val?.askingMember?.nameDisplayAs ?? val?.askingMemberName ?? 'an MP');
        const heading = stripHtml(val?.heading ?? 'Written Parliamentary Question');
        const questionText = stripHtml(val?.questionText ?? '');
        const answerText = stripHtml(val?.answerText ?? '');

        pushQuestionRecord(answeringMemberId, 'answered', {
            id: val?.id,
            uin,
            department,
            askingMemberName,
            heading,
            questionText: extractCleanExcerpt(questionText, 400) || questionText,
            answerText: answerText ? (extractCleanExcerpt(answerText, 650) || answerText) : null,
            dateAnswered: val?.dateAnswered ? String(val.dateAnswered).slice(0, 10) : dateStr,
            url: uin
                ? `https://questions-statements.parliament.uk/written-questions/detail/${tabledDate}/${encodeURIComponent(uin)}`
                : 'https://questions-statements.parliament.uk/'
        });
    }

    return byMember;
}
