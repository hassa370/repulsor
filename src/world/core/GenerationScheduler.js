import { WORLD_BUDGET } from '../../config.js';

// Time-sliced procedural work. Systems rebuild their wish list every frame
// (so jobs for places the player already passed simply stop being requested),
// then the scheduler runs the most urgent ones until the per-frame budget is
// spent. At least one job runs per frame so streaming can never stall.
//
// A job is { priority (lower = sooner), run() }. Job objects are owned and
// reused by the requesting system; the scheduler never allocates per frame.
export class GenerationScheduler {
  constructor(budgetMs = WORLD_BUDGET.generationBudgetMs, now = () => performance.now()) {
    this.budgetMs = budgetMs;
    this.now = now;
    this.jobs = [];
    this.count = 0;
    this.lastMs = 0; // time spent last frame
    this.lastRun = 0; // jobs run last frame
    this.pending = 0; // jobs left over last frame (queue length)
    this.byPriority = (a, b) => a.priority - b.priority;
  }

  request(job) {
    if (this.count < this.jobs.length) this.jobs[this.count] = job;
    else this.jobs.push(job);
    this.count++;
  }

  // Run queued jobs within the budget; clears the queue for the next frame.
  run(budgetMs = this.budgetMs) {
    const n = this.count;
    const jobs = this.jobs;
    jobs.length = n; // drop stale references (length only shrinks: no allocation)
    if (n > 1) jobs.sort(this.byPriority);
    const t0 = this.now();
    let ran = 0;
    for (let i = 0; i < n; i++) {
      if (ran > 0 && this.now() - t0 >= budgetMs) break;
      jobs[i].run();
      ran++;
    }
    this.lastMs = this.now() - t0;
    this.lastRun = ran;
    this.pending = n - ran;
    this.count = 0;
    return ran;
  }

  // Run everything regardless of budget (initial load / respawn behind a fade).
  flush() {
    return this.run(Infinity);
  }
}
