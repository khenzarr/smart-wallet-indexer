import { spawn } from 'child_process';

const LOOP_INTERVAL_SECONDS = Number(
  process.env.SMART_WHALE_MONITOR_LOOP_INTERVAL_SECONDS || 60
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runMonitorOnce() {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();

    console.log('');
    console.log('============================================================');
    console.log(`Smart whale monitor loop tick: ${startedAt}`);
    console.log('============================================================');

    const child = spawn('node', ['monitor-smart-whales.mjs'], {
      stdio: 'inherit',
      shell: true,
    });

    child.on('close', (code) => {
      const endedAt = new Date().toISOString();

      if (code === 0) {
        console.log(`Smart whale monitor run completed at ${endedAt}`);
      } else {
        console.log(`Smart whale monitor exited with code ${code} at ${endedAt}`);
      }

      resolve();
    });

    child.on('error', (err) => {
      console.log(`Smart whale monitor spawn error: ${err.message}`);
      resolve();
    });
  });
}

async function main() {
  console.log('Smart Whale Monitor Loop v1.1');
  console.log(`Interval: ${LOOP_INTERVAL_SECONDS} seconds`);
  console.log('Press CTRL + C to stop.');
  console.log('');

  while (true) {
    await runMonitorOnce();

    console.log('');
    console.log(`Sleeping ${LOOP_INTERVAL_SECONDS} seconds...`);
    console.log('');

    await sleep(LOOP_INTERVAL_SECONDS * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});