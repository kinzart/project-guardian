import { scanCommand } from './commands/scan.js';
import { listCommand } from './commands/list.js';
import { showCommand } from './commands/show.js';
import { statusCommand } from './commands/status.js';
import { doctorCommand } from './commands/doctor.js';
import { contextCommand } from './commands/context.js';
import { explainCommand } from './commands/explain.js';
import { watchCommand } from './commands/watch.js';
import { watchStatusCommand } from './commands/watchStatus.js';
import { eventsCommand } from './commands/events.js';
import { processesCommand } from './commands/processes.js';
import { sessionsCommand } from './commands/sessions.js';
import { processStatusCommand } from './commands/processStatus.js';
import { observeCommand } from './commands/observe.js';
import { shellsCommand } from './commands/shells.js';
import { shellEventsCommand } from './commands/shellEvents.js';
import { shellCommand } from './commands/shell.js';
import { agentsCommand } from './commands/agents.js';
import { agentCommand } from './commands/agent.js';
import { handoffCommand } from './commands/handoff.js';
import { obsidianCommand } from './commands/obsidian.js';
import { cerebroCommand } from './commands/cerebro.js';
import { askCommand, queryCommand } from './commands/query.js';
import { serviceCommand } from './commands/service.js';
import { serviceHostCommand } from './commands/serviceHost.js';
import { installCommand, repairCommand, uninstallCommand } from './commands/product.js';

const COMMANDS = {
  scan: scanCommand,
  list: listCommand,
  show: showCommand,
  status: statusCommand,
  doctor: doctorCommand,
  context: contextCommand,
  explain: explainCommand,
  watch: watchCommand,
  'watch-status': watchStatusCommand,
  events: eventsCommand,
  processes: processesCommand,
  sessions: sessionsCommand,
  'process-status': processStatusCommand,
  observe: observeCommand,
  shells: shellsCommand,
  'shell-events': shellEventsCommand,
  shell: shellCommand,
  agents: agentsCommand,
  agent: agentCommand,
  handoff: handoffCommand,
  obsidian: obsidianCommand,
  cerebro: cerebroCommand,
  ask: askCommand,
  query: queryCommand,
  service: serviceCommand,
  'service-host': serviceHostCommand,
  install: installCommand,
  uninstall: uninstallCommand,
  repair: repairCommand,
};

const USAGE =
  'Usage: guardian <install|uninstall|repair|scan|list|show|status|doctor|context|explain|watch|watch-status|events|processes|sessions|process-status|observe|shells|shell-events|shell|agents|agent|handoff|obsidian|cerebro|query|ask|service> [args]';

export async function runCli(argv, { projectRoot, appRoot = projectRoot }) {
  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  return handler({ projectRoot, appRoot, args });
}
