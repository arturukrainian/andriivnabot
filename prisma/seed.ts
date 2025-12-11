import { prisma } from '../src/db/prisma.js';

async function main(): Promise<void> {
  const lessonCount = await prisma.lesson.count();
  if (lessonCount > 0) {
    return;
  }

  await prisma.lesson.createMany({
    data: [
      { slug: 'a1-hello', title: 'A1 Hello', level: 1, isPublished: true },
      { slug: 'a1-intro', title: 'A1 Intro', level: 1, isPublished: true },
    ],
    skipDuplicates: true,
  });
}

main()
  .catch((err) => {
    console.error('Seed failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
