#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

function printUsage() {
  console.error('Usage: dotenv [-e <path>] -- <command> [args...]');
}

function parseArgs(argv) {
  let envPath = '.env';
  const cleaned = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '-e' || arg === '--env' || arg === '--path') {
      envPath = argv[i + 1] ?? envPath;
      i += 2;
      continue;
    }
    if (arg === '--') {
      return { envPath, commandArgs: argv.slice(i + 1) };
    }
    cleaned.push(arg);
    i += 1;
  }
  return { envPath, commandArgs: cleaned };
}

function loadEnv(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    return {};
  }
  const result = dotenv.config({ path: resolved });
  if (result.error) {
    console.error(`Failed to load env file at ${filePath}:`, result.error);
    process.exit(1);
  }
  return result.parsed ?? {};
}

const { envPath, commandArgs } = parseArgs(process.argv.slice(2));

if (commandArgs.length === 0) {
  printUsage();
  process.exit(1);
}

const env = { ...process.env, ...loadEnv(envPath) };
const child = spawn(commandArgs[0], commandArgs.slice(1), {
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
