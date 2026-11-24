import { describe, expect, it, vi } from 'vitest'
import {
  advanceVocabularyReviewSession,
  buildAnkiTsv,
  vocabularyStudyContext,
  vocabularyReviewCloze,
  vocabularyStudyPrompt,
  vocabularyReferencePreview,
  createVocabularyLifecycleGuard,
  createVocabularyReviewSession,
  reconcileVocabularyReviewQueue,
  reconcileVocabularyReviewSession,
  vocabularyImportNeedsConfirmation,
  vocabularyReviewSessionProgress,
  normalizeLearningSourceText,
  isVocabularySentence,
  mergeVocabularyNotes,
  type VocabularyEntry,
} from '@/src/features/vocabulary/learningModel'

const NOW = 10_000

function entry(id: string, overrides: Partial<VocabularyEntry> = {}): VocabularyEntry {
  return {
    id,
    identityKey: `en:${id}`,
    sourceLanguage: 'en',
    term: id,
    normalizedTerm: id,
    translations: {},
    phonetic: '',
    partOfSpeech: '',
    contexts: [],
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
    encounterCount: 1,
    masteryLevel: 0,
    status: 'new',
    nextReviewAt: NOW,
    lastReviewedAt: null,
    reviewCount: 0,
    lapseCount: 0,
    schemaVersion: 1,
    ...overrides,
  }
}

describe('vocabulary learning model edge cases', () => {
  it('finds explicit and legacy sentences without classifying words or explicit expressions as sentences', () => {
    expect(isVocabularySentence(entry('sentence', {kind:'sentence'}))).toBe(true);
    expect(isVocabularySentence(entry('A full sentence.', {kind:'expression'}))).toBe(false);
    for (const term of ['This is worth remembering.', '这是一个句子。', 'Do you agree?', '“Read this!”']) expect(isVocabularySentence(entry(term))).toBe(true);
    for (const term of ['word', 'Dr.', 'on time']) expect(isVocabularySentence(entry(term))).toBe(false);
    expect(vocabularyStudyPrompt('sentence')).toContain('最多三句');
  });
  it('merges explanations using their own timestamps and preserves deliberate clears', () => {
    expect(mergeVocabularyNotes(entry('a'), entry('b'))).toEqual({});
    const older = entry('a', {note:'old', noteUpdatedAt:10});
    const newer = entry('b', {note:'', noteUpdatedAt:20});
    expect(mergeVocabularyNotes(older, newer)).toEqual({note:'', noteUpdatedAt:20});
    expect(mergeVocabularyNotes(newer, older)).toEqual({note:'', noteUpdatedAt:20});
    expect(mergeVocabularyNotes(entry('a', {noteUpdatedAt:20}), entry('b'))).toEqual({note:'', noteUpdatedAt:20});
  });
  it('validates multilingual learning text without truncating long selections', () => {
    expect(normalizeLearningSourceText(null)).toBe('');
    expect(normalizeLearningSourceText('  Café\n 是一个词。\u0000 ')).toBe('Café 是一个词。');
    expect(normalizeLearningSourceText('…?!')).toBe('');
    expect(normalizeLearningSourceText('a'.repeat(4096))).toHaveLength(4096);
    expect(normalizeLearningSourceText('a'.repeat(4097))).toBe('');
  });
  it('normalizes empty export cells, invalid sizes and empty cloze inputs', () => {
    expect(buildAnkiTsv([null as unknown as string], [[undefined]])).toBe(
      '#separator:tab\n#html:false\n#columns:\n',
    )
    expect(vocabularyImportNeedsConfirmation(Number.NaN)).toBe(false)
    expect(vocabularyReviewCloze({term: 'word', contexts: [{text: '', capturedAt: NOW}]})).toBe('')
    expect(vocabularyReviewCloze({term: '', contexts: [{text: 'word', capturedAt: NOW}]})).toBe('')
  })

  it('deduplicates queue entries and advances non-head or missing entries safely', () => {
    const first = entry('first')
    const second = entry('second')
    expect(reconcileVocabularyReviewQueue([first, first], [first], NOW)).toEqual([first])

    const session = createVocabularyReviewSession([first, second])
    expect(advanceVocabularyReviewSession(session, 'second')).toMatchObject({
      queue: [first],
      completed: 1,
      answerVisible: false,
    })
    expect(advanceVocabularyReviewSession(session, 'missing')).toMatchObject({
      queue: [first, second],
      completed: 0,
      answerVisible: false,
    })
  })

  it('detects each kind of current-card change and preserves an unchanged answer', () => {
    const current = entry('current')
    const session = { queue: [current], completed: 2, answerVisible: true }

    expect(reconcileVocabularyReviewSession(session, [], NOW).answerVisible).toBe(false)
    expect(reconcileVocabularyReviewSession(session, [entry('other')], NOW).answerVisible).toBe(false)
    expect(reconcileVocabularyReviewSession(session, [entry('current', { updatedAt: 2 })], NOW).answerVisible).toBe(false)
    expect(reconcileVocabularyReviewSession(session, [entry('current', { reviewCount: 1 })], NOW).answerVisible).toBe(false)
    expect(reconcileVocabularyReviewSession(session, [current], NOW).answerVisible).toBe(true)

    expect(vocabularyReviewSessionProgress({ queue: [], completed: 2, answerVisible: false })).toEqual({
      current: null,
      position: 2,
      total: 2,
    })
  })

  it('runs initialization only while the lifecycle remains active', async () => {
    const initialize = vi.fn()
    const active = createVocabularyLifecycleGuard()
    await expect(active.runAfterReady(Promise.resolve(), initialize)).resolves.toBe(true)
    expect(initialize).toHaveBeenCalledOnce()

    const disposedDuringInitialization = createVocabularyLifecycleGuard()
    await expect(disposedDuringInitialization.runAfterReady(Promise.resolve(), () => {
      disposedDuringInitialization.dispose()
    })).resolves.toBe(false)
  })
})


describe('context-grounded vocabulary study', () => {
  it.each([
    ['学习', '我每天学习中文。', '我每天____中文。'],
    ['かな', 'ひらがなのかなを読む。', 'ひらがなの____を読む。'],
    ['カタカナ', '今カタカナを読む。', '今____を読む。'],
    ['art', '我喜欢art作品。', '我喜欢____作品。'],
  ])('uses the saved %s expression in a continuous multilingual sentence', (term, text, cloze) => {
    const context = {text, capturedAt: 2}; const saved = entry(term, {contexts: [context]}); const before = structuredClone(saved);
    expect(vocabularyStudyContext(saved)).toBe(context); expect(vocabularyReviewCloze(saved)).toBe(cloze);
    expect(saved).toEqual(before);
  });
  it('matches canonical accents and flexible whitespace while leaving the remaining original sentence intact', () => {
    expect(vocabularyReviewCloze({term: 'CAFÉ', contexts: [{text: 'A cafe\u0301 serves tea.', capturedAt: NOW}]})).toBe('A ____ serves tea.');
    expect(vocabularyReviewCloze({term: 'on time', contexts: [{text: 'We arrive on\n  time, or on\ttime.', capturedAt: NOW}]})).toBe('We arrive ____, or ____.');
    expect(vocabularyReviewCloze({term: "don't", contexts: [{text: 'Use don’t and re‑enter today.', capturedAt: NOW}]})).toBe('Use ____ and re‑enter today.');
  });
  it('still rejects embedded Latin words, lone terms and unrelated clues after multilingual matching', () => {
    expect(vocabularyReviewCloze({term: 'art', contexts: [{text: 'artful cart art2 2art art.', capturedAt: NOW}]})).toBe('artful cart art2 2art ____.');
    expect(vocabularyStudyContext(entry('学习', {contexts: [{text: '学习学习！', capturedAt: 1}]}))).toBeUndefined();
    expect(vocabularyReviewCloze(entry('学习', {contexts: [{text: '我喜欢中文。', capturedAt: 1}]}))).toBe('');
    expect(vocabularyStudyContext(entry('word', {contexts: [{text: '', capturedAt: 1}]}))).toBeUndefined();
  });
  it('selects the newest relevant sentence without inventing clues or mutating saved contexts', () => {
    const contexts = [
      {text: 'We arrived on time.', capturedAt: 3},
      {text: 'on time', capturedAt: 5},
      {text: 'Nothing relevant here.', capturedAt: 6},
      {text: 'The train left on time.', capturedAt: 2},
    ];
    const before = structuredClone(contexts);
    const saved = entry('on time', {term: 'on time', contexts});
    expect(vocabularyStudyContext(saved)).toBe(contexts[0]);
    expect(vocabularyReviewCloze(saved)).toBe('We arrived ____.');
    expect(saved.contexts).toEqual(before);
    expect(vocabularyReviewCloze(entry('word', {contexts: [{text: 'word!', capturedAt: 1}]}))).toBe('');
    expect(vocabularyReviewCloze(entry('word', {contexts: [{text: 'sword fish', capturedAt: 1}]}))).toBe('');
    expect(vocabularyStudyContext(entry('word'))).toBeUndefined();
  });

  it('asks for one expression with evidence and distinguishes original context from generated examples', () => {
    const question = vocabularyStudyPrompt('understand');
    expect(question).toContain('不另选词');
    expect(question).toContain('缺少语境');
    expect(question).toContain('read_context');
    expect(question).toContain('自拟例句');
    expect(question).toContain('不出随机填空题');
    expect(question.length).toBeLessThanOrEqual(1000);
  });

  it('asks for minimal usage corrections without scoring mastery or embedding learner data', () => {
    const prompt = vocabularyStudyPrompt('use');
    expect(prompt).toContain('最小修改');
    expect(prompt).toContain('区分错误和可选润色');
    expect(prompt).toContain('不得编造用户成绩或更新复习状态');
    expect(prompt).toContain('用户当前问题中的文字就是需要反馈的造句');
  });

  it('keeps long collected AI explanations as a short list preview without losing the original', () => {
    expect(vocabularyReferencePreview('### 用法\n**on time** > `按时`')).toBe('用法 on time 按时');
    expect(vocabularyReferencePreview('字'.repeat(500))).toHaveLength(120);
    expect(vocabularyReferencePreview('')).toBe('');
  });
});
