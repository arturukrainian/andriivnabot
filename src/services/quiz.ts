type QuizOption = { id: string; text: string; correct?: boolean };
export type QuizQuestion = { id: string; text: string; options: QuizOption[] };

const questions: QuizQuestion[] = [
  {
    id: 'q1',
    text: 'Choose the correct translation for "apple":',
    options: [
      { id: 'a', text: 'яблуко', correct: true },
      { id: 'b', text: 'груша' },
      { id: 'c', text: 'слива' },
    ],
  },
  {
    id: 'q2',
    text: 'Pick the past tense of "go":',
    options: [
      { id: 'a', text: 'goed' },
      { id: 'b', text: 'went', correct: true },
      { id: 'c', text: 'gone' },
    ],
  },
];

export function getQuestion(): QuizQuestion {
  return questions[Math.floor(Math.random() * questions.length)];
}

export function checkAnswer(questionId: string, choiceId: string): boolean {
  const question = questions.find((q) => q.id === questionId);
  if (!question) return false;
  const choice = question.options.find((o) => o.id === choiceId);
  return Boolean(choice?.correct);
}

export function buildInlineKeyboard(question: QuizQuestion) {
  return {
    inline_keyboard: [
      question.options.map((opt) => ({
        text: opt.text,
        callback_data: `quiz:${question.id}:${opt.id}`,
      })),
    ],
  };
}
