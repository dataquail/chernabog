// `chernabog install` registers the daemon as a launchd agent on macOS, or a
// systemd user service on Linux, that restarts on exit.

import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';

import { ConfigError, Home, homePaths } from './config.ts';
import { Exec, execOk } from './Exec.ts';
import { type Environment, HostEnvironment } from './platform/environment.ts';
import { selfCommand } from './self.ts';

export const LABEL = 'com.dataquail.chernabog';

export const launchAgentPath = (home: string) => `${home}/Library/LaunchAgents/${LABEL}.plist`;
export const systemdUnitPath = (home: string) => `${home}/.config/systemd/user/chernabog.service`;

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The service starts with launchd's bare PATH unless it is given one: gh, git,
// claude and the agents' own tools all come from the PATH of whoever installs it.
export const serviceEnv = (env: Environment, home: string): Environment => ({
  PATH: Option.getOrElse(Record.get(env, 'PATH'), () => '/usr/local/bin:/usr/bin:/bin'),
  HOME: Option.getOrElse(Record.get(env, 'HOME'), () => home),
  ...Object.fromEntries(Option.toArray(Option.map(Record.get(env, 'CHERNABOG_HOME'), (root) => ['CHERNABOG_HOME', root]))),
});

export const launchAgentPlist = (command: ReadonlyArray<string>, env: Environment, logPath: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[...command, 'daemon'].map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([key, value]) => `    <key>${key}</key>\n    <string>${escapeXml(value)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;

const quote = (value: string) => {
  if (/^[\w./:@-]+$/.test(value)) return value;

  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
};

export const systemdUnit = (command: ReadonlyArray<string>, env: Environment, logPath: string) => `[Unit]
Description=Chernabog daemon: spends spare coding-agent capacity on queued work

[Service]
ExecStart=${[...command, 'daemon'].map(quote).join(' ')}
${Object.entries(env)
  .map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`)
  .join('\n')}
Restart=always
RestartSec=10
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

const DEFAULT_UID = 501;

const domain = Effect.map(HostEnvironment, (host) => `gui/${Option.getOrElse(host.userId, () => DEFAULT_UID)}`);

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

const unitPath = Effect.gen(function* () {
  const { platform } = yield* HostEnvironment;
  const { user } = yield* Home;

  if (platform === 'darwin') return launchAgentPath(user);

  return systemdUnitPath(user);
});

const writeUnit = (path: string, contents: string) =>
  FileSystem.FileSystem.use((fs) => fs.makeDirectory(directoryOf(path), { recursive: true }).pipe(Effect.andThen(fs.writeFileString(path, contents))));

export const install = Effect.gen(function* () {
  const host = yield* HostEnvironment;
  const home = yield* Home;
  const paths = homePaths(home.root);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(home.root, { recursive: true });
  const command = selfCommand();
  const env = serviceEnv(host.variables, home.user);

  if (host.platform === 'darwin') {
    const path = launchAgentPath(home.user);
    const gui = yield* domain;
    yield* (yield* Exec).run('launchctl', ['bootout', `${gui}/${LABEL}`]);
    yield* writeUnit(path, launchAgentPlist(command, env, paths.daemonLog));
    yield* execOk('launchctl', ['bootstrap', gui, path]);

    return `installed and started ${path}`;
  }

  if (host.platform === 'linux') {
    const path = systemdUnitPath(home.user);
    yield* writeUnit(path, systemdUnit(command, env, paths.daemonLog));
    yield* execOk('systemctl', ['--user', 'daemon-reload']);
    yield* execOk('systemctl', ['--user', 'enable', '--now', 'chernabog.service']);

    return `installed and started ${path}`;
  }

  return yield* new ConfigError({ message: `no service manager for ${host.platform}; run chernabog daemon yourself` });
});

export const uninstall = Effect.gen(function* () {
  const exec = yield* Exec;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* unitPath;

  if ((yield* HostEnvironment).platform === 'darwin') yield* exec.run('launchctl', ['bootout', `${yield* domain}/${LABEL}`]);
  else yield* exec.run('systemctl', ['--user', 'disable', '--now', 'chernabog.service']);

  yield* fs.remove(path, { force: true });

  return `removed ${path}`;
});

export const isInstalled = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.exists(yield* unitPath);
}).pipe(Effect.orElseSucceed(() => false));

export const startService = Effect.gen(function* () {
  if (!(yield* isInstalled)) return yield* new ConfigError({ message: 'the daemon is not installed; run chernabog install' });

  if ((yield* HostEnvironment).platform === 'darwin') {
    const gui = yield* domain;
    const loaded = yield* (yield* Exec).run('launchctl', ['print', `${gui}/${LABEL}`]);

    if (loaded.exitCode !== 0) yield* execOk('launchctl', ['bootstrap', gui, yield* unitPath]);
    else yield* execOk('launchctl', ['kickstart', `${gui}/${LABEL}`]);
  } else yield* execOk('systemctl', ['--user', 'start', 'chernabog.service']);

  return 'started';
});

// Stops the daemon until the next start or login. Runs in flight resume when it comes back.
export const stopService = Effect.gen(function* () {
  if ((yield* HostEnvironment).platform === 'darwin') yield* (yield* Exec).run('launchctl', ['bootout', `${yield* domain}/${LABEL}`]);
  else yield* execOk('systemctl', ['--user', 'stop', 'chernabog.service']);

  return 'stopped; runs in flight resume when it starts again';
});
