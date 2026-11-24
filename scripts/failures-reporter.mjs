import { writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * A Vitest reporter that writes every failed test with its errors' messages, as JSON, to the file
 * SWF_FAILURES_FILE names. Vitest's own JSON report keeps an error's stack alone, and Firefox's
 * stacks do not carry the message, so a failure in Firefox would be recorded without saying what
 * failed.
 */
export default class FailuresReporter {
  onTestRunEnd(testModules) {
    const file = process.env.SWF_FAILURES_FILE;
    if (file === undefined || file === '') {
      throw new Error('SWF_FAILURES_FILE must name the file failures are written to');
    }
    const failures = [];
    for (const module of testModules) {
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state === 'failed') {
          failures.push({
            file: module.relativeModuleId,
            name: test.fullName,
            errors: (result.errors ?? []).map((e) => ({
              message: String(e.message ?? ''),
              stack: String(e.stack ?? ''),
            })),
          });
        }
      }
    }
    writeFileSync(file, `${JSON.stringify(failures, null, 2)}\n`);
  }
}
