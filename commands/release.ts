import { BaseCommand, c, execute, readJson, writeJson } from '@codaxio/cdx';
import fs from 'fs';
import path from 'path';

export function log(...msg: unknown[]) {
  console.log(c.green('RELEASEME'), '>', ...msg);
}

function formatVersion(version: string, bump: 'major' | 'minor' | 'patch') {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') {
    return c.bold(`${c.red(`${major}`)}.${c.green(`0`)}.${c.yellow(`0`)}`);
  } else if (bump === 'minor') {
    return c.bold(`${major}.${c.green(`${minor}`)}.${c.yellow(`0`)}`);
  } else {
    return c.bold(`${major}.${minor}.${c.yellow(`${patch}`)}`);
  }
}

export default class ReleaseCommand extends BaseCommand {
  name = 'release';
  description = 'Create a new release';
  options: [string, string, (string | boolean)?][] = [
    ['-t, --target [target]', 'The target branch'],
    ['-s, --source [source]', 'The source branch'],
    ['-n, --dry-run', 'Only print release', false],
    ['--pr [pr_id]', 'The PR id'],
    ['--publish', 'Publish all packages'],
  ];

  defaultConfig = {
    repository: '<owner>/<repo>',
    manifestPath: '.release-manifest.json',
    targetBranch: 'release/autorelease',
    sourceBranch: 'feature/autorelease',
    defaultBranch: 'main',
    rootPackage: false,
    scan: [],
    pullRequest: {
      labels: ['autorelease: pending'],
      title: 'chore: release ${version}',
      header: ':robot: Autorelease',
      fix: '### Bug Fixes',
      feat: '### Features',
      docs: '### Documentation',
      test: '### Tests',
      chore: '### Chore',
      dependencies: '### Dependencies',
      other: '### Other Changes',
    },
    sections: ['feat', 'fix', 'docs', 'test'],
    hooks: {
      generate: {
        header: async ({
          release,
          year,
          month,
          day,
          commandConfig,
        }: {
          release: Release;
          year: string;
          month: string;
          day: string;
          commandConfig: any;
        }) => {
          return `## [${release.next}](https://github.com/${
            commandConfig.repository
          }/compare/${await commandConfig.hooks.generate.tag(
            release,
            release.current,
          )}...${await commandConfig.hooks.generate.tag(release, release.next)}) (${year}-${month}-${day})\n\n`;
        },
        tag: async (release: Release, version: string) => {
          return `${release.json.name}-v${version}`;
        },
      },
      onChangelog: async (manifest: Manifest) => {},
      onScanFinished: async (manifest: Manifest) => {},
      buildAndPublish: async (release: Release) => {
        const json = readJson(`${release.path}/package.json`);
        const namespace = json.namespace;
        const pkgName = json.name?.split('/').pop();
        const version = json.version;

        const publishToCodeArtifact = json.publishToCodeArtifact;
        const dockerize = json.dockerize;
        if (publishToCodeArtifact !== true) {
          log(`Package publishing to CodeArtifact is disabled for ${c.yellow(json.name)}, skipping...`);
        } else {
          const targetPackage = `${namespace}/${pkgName}@${version}`;
          log(`Prepare publishing ${c.yellow(targetPackage)}...`);
          const exists = await execute(
            `aws codeartifact list-package-versions --domain "ra2" --repository "ra2-dev" --domain-owner "927114455157" --format npm --namespace "${namespace?.replace(
              '@',
              '',
            )}" --package "${pkgName}" --query "versions[?version=='${
              release.next
            }'].version" --output text 2> /dev/null`,
          ).then((x) => x.stdout.split('\n').filter((x) => x));
          console.log({ exists });
          if (!exists.length) {
            log(`Package ${c.yellow(`${release.name}@${release.next}`)} already exists in CodeArtifact, skipping...`);
            return false;
          }
          log(`Publishing ${c.green(targetPackage)} to ${'ra2-dev'}...`);
          const publish = await execute(`echo pnpm publish`, { cwd: release.path });
          log({ publish });
          return { name: release.name, version: release.next, tag: targetPackage };
        }
        if (dockerize !== true) {
          log(`${c.yellow(json.name)}: Package dockerization is disabled, skipping...`);
        } else {
          const imageTag = `${json.name.replaceAll('@', '').replaceAll('/', '-')}-${version}`;
          log(`${c.yellow(imageTag)}: Prepare publishing...`);
          const exists = await execute(
            `aws ecr describe-images --repository-name="usdn-backend" --image-ids=imageTag="${imageTag} 2> /dev/null`,
          ).then((x) => x.stdout.split('\n').filter((x) => x));
          console.log({ exists });
          if (exists.length) {
            log(`${c.yellow(imageTag)}: Package already exists in ECR [usdn-backend], skipping...`);
            return false;
          } else {
            log(`${c.yellow(imageTag)}: Building Docker image`);
            if (!fs.existsSync(`${release.path}/Dockerfile`)) {
              log(`${c.yellow(imageTag)}: Dockerfile not found in ${release.path}, skipping...`);
              return false;
            }
            const Dockerfile = fs.readFileSync(`${release.path}/Dockerfile`).toString();
            let target = '';
            if (Dockerfile.includes('AS production')) {
              target = '--target production';
            } else {
              log(`${c.yellow(imageTag)}: Production target not found, building the full Dockerfile...`);
            }
            const npmrc = execute(`echo cat ~/.npmrc`).then((x) => x.stdout.trim());
            await execute(
              `echo docker build ${target} -t "927114455157.dkr.ecr.eu-central-1.amazonaws.com/usdn-backend:${imageTag}" . --no-cache --build-arg NPMRC="${npmrc}"`,
              { cwd: release.path },
            );
            await execute(
              `echo aws ecr describe-repositories --repository-names usdn-backend || aws ecr create-repository --repository-name usdn-backend`,
            );
            log(`${c.yellow(imageTag)}: Publishing to ECR...`);
            const digest = await execute(
              `echo docker push "927114455157.dkr.ecr.eu-central-1.amazonaws.com/usdn-backend:${imageTag}"`,
            ).then(
              (x) =>
                x.stdout
                  .split('\n')
                  .filter((x) => x)
                  .filter((x) => x.includes('sha256'))[0]
                  .split('sha256:')[1]
                  .split(' ')[0],
            );

            return { name: release.name, version: release.next, digest, tag: imageTag };
          }
        }
      },
      onPublish: async (
        manifest: {
          releases: Release[];
        },
        commandConfig: any,
        prId: string,
      ) => {
        // Build packages
        const releases = manifest.releases;
        if (!releases) {
          log('No releases found');
          return;
        }
        const dependencies = releases
          .map((r) => r.dependencies)
          .flat()
          // filter duplicate by name
          .filter((dep, i, a) => a.findIndex((d) => d.name === dep.name) === i);
        const dependenciesNames = dependencies.map((x) => x.name);

        let released = [];
        if (dependenciesNames.length) {
          await execute(`echo pnpm --workspace-concurrency Infinity -F ${dependenciesNames.join(' -F ')} build`, {
            stdout: process.stdout,
          });
          released.push(
            ...(await Promise.all(dependencies.map(async (dep) => await commandConfig.hooks.buildAndPublish(dep)))),
          );
        }
        const unreleased = releases.filter((r) => !dependenciesNames.includes(r.name));
        unreleased.forEach((release) => {
          const json = readJson(`${release.path}/package.json`);
          release.dependencies.forEach((dep) => {
            if (json.dependencies?.[dep.name]) json.dependencies[dep.name] = dep.nextRange;
            if (json.devDependencies?.[dep.name]) json.devDependencies[dep.name] = dep.nextRange;
            if (json.peerDependencies?.[dep.name]) json.peerDependencies[dep.name] = dep.nextRange;
          });
          writeJson(`${release.path}/package.json`, json);
        });

        await execute(`echo pnpm install`);
        const releasesNames = unreleased.map((x) => x.name);
        if (releasesNames.length) {
          await execute(`echo pnpm --workspace-concurrency Infinity -F ${releasesNames.join(' -F ')} build`, {
            stdout: process.stdout,
          });
          released.push(
            ...(await Promise.all(
              unreleased.map(async (release) => await commandConfig.hooks.buildAndPublish(release)),
            )),
          );
        }

        released = released.filter((x) => x);
        await execute(
          `gh pr comment ${prId} --body "Packages published:\n\n ${released
            .map((x) => `${x.digest ? `ECR ${x.tag} = "sha256:${x.digest}"` : `CodeArtifact: ${x.tag}`}`)
            .join('\n')}"`,
        );
        await execute(
          `gh pr edit ${prId} --add-label="autorelease: published" --remove-label="autorelease: ready"  --remove-label="autorelease: ready"`,
        );
      },
    },
  };

  async run(options: Record<string, any>, command: any) {
    log('Running release command');
    log(JSON.stringify(options, null, 2));
    const commandConfig = this.mergeConfig(this.defaultConfig, 'release');
    if (options.publish) {
      log('Publishing packages...');
      const manifest = JSON.parse(fs.readFileSync(commandConfig.manifestPath).toString());
      await commandConfig.hooks.onPublish(manifest, commandConfig, options.pr);
      process.exit(0);
    }
    if (options.pr) {
      await execute('gh label create "autorelease: pending" -f --description "Preparing auto-release" --color E99695');
      await execute('gh label create "autorelease: ready" -f --description "Ready to publish" --color 2EA44F');
      await execute('gh label create "autorelease: published" -f --description "Published" --color C0DFEF');
      if (options.pr && options.pr !== true) {
        await execute(
          `gh pr edit ${options.pr} --add-label="autorelease: pending" --remove-label="autorelease: ready"`,
        );
      }
    }
    const manifest = new Manifest({
      path: commandConfig.manifestPath,
    });
    await manifest.generate({
      source: options.source || commandConfig.sourceBranch,
      target: options.target || commandConfig.targetBranch,
      hasRootPackage: commandConfig.rootPackage,
      scan: commandConfig.scan.map((path: string) => {
        if (path.endsWith('/')) return path;
        if (path.endsWith('*')) return path.slice(0, -1).replace(/\/$/, '') + '/';
        return path + '/';
      }),
    });
    await commandConfig.hooks.onScanFinished(manifest);

    log(`Preparing ${manifest.releases.size} release${manifest.releases.size ? 's' : ''}...`);
    if (!manifest.releases.size) {
      this.log('No changes detected, skipping release...');
      return;
    }
    const [year, month, day] = new Date().toISOString().split('T')[0].split('-');
    await manifest.generateChangelog({ year, month, day, commandConfig });
    if (options.dryRun) {
      log('Dry run enabled, skipping release...');
      return;
    }

    if (options.pr) {
      if (options.pr && options.pr !== true) {
        if (options.source == commandConfig.defaultBranch) {
          // PR was created from default branch
          log(
            c.red(`Cannot use default branch "${c.green(options.source)}",
Please reopen a PR from a feature branch based on "${c.green(options.source)}"`),
          );
          process.exit(1);
        }
      }
      if (options.pr === true && commandConfig.defaultBranch == options.source) {
        await execute(`git checkout -B ${commandConfig.sourceBranch} ${options.source}`);
      }

      manifest.save().applyBumps().updateChangelogs().createOrUpdatePR({
        options,
        commandConfig,
      });
    }
  }
}

export class Manifest {
  path: string;
  config: any;
  changelog: string = '';
  commits: Commit[] = [];
  releases: Map<string, Release> = new Map();
  constructor({ path }: { path: string }) {
    this.path = path;
    this.config = readJson(path);
    if (this.config?.releases?.length) {
      this.reset();
    }
  }

  async generate({
    source,
    target,
    hasRootPackage,
    scan,
  }: {
    source: string;
    target: string;
    hasRootPackage: boolean;
    scan: string[];
  }) {
    log(`Scanning commits between ${target} and ${source}...`);
    if (hasRootPackage) {
      this.releases.set(
        '@root',
        new Release({
          path: '.',
          name: '@root',
        }),
      );
    }

    const logs = await execute(
      `git log --cherry-pick --format='%H %ct %s' --no-merges --left-only ${source}...origin/${target}`,
    ).then((x) => x.stdout);
    this.commits = await Promise.all(
      logs
        .split('\n')
        .filter((log: string) => log)
        .map(async (log: string) => {
          const [hash, timestamp, ...message] = log.split(' ');
          const commit = new Commit({ hash, timestamp, message: message.join(' ') });
          await commit.getFiles(hash);
          return commit;
        }),
    );
    if (!this.commits.length) {
      log('No commits found, skipping release...');
      process.exit(0);
    }
    log(`${c.blue(this.commits.length)} commits found`);
    const files = this.commits.flatMap((commit) => commit.files).filter((file, i, a) => a.indexOf(file) === i);
    log(`${c.blue(files.length)} files changed`);
    this.commits.forEach((commit: Commit) => {
      commit.checkImpact(
        scan.map((p) => path.resolve(p)),
        hasRootPackage,
        this.releases,
      );
      return commit;
    });

    const maxLength = Math.max(...Array.from(this.releases.values()).map((release) => release.json.name.length));

    Array.from(this.releases.values())
      .filter((release) => {
        if (release.commits.length) {
          log(
            `bumping ${c.bold(c.magenta(release.json.name))}`.padEnd((9 + maxLength) * 2, ' '),
            `from ${c.bold(c.cyan(release.current.padEnd(8, ' ')))}`,
            `to ${formatVersion(release.next, release.bump as Bump)}${release.next
              .padEnd(8, ' ')
              .replace(release.next, '')}`,
            `[${c.green(
              c[release.bump === 'major' ? 'red' : release.bump === 'minor' ? 'green' : 'yellow'](release.bump),
            )}]`,
          );
          return true;
        }
        return false;
      })
      .forEach((release) => {
        const dependencies = release.json.dependencies || {};
        const devDependencies = release.json.devDependencies || {};
        const peerDependencies = release.json.peerDependencies || {};
        const allDependencies = { ...dependencies, ...devDependencies, ...peerDependencies };
        for (const dep of Object.keys(allDependencies)) {
          if (this.releases.has(dep)) {
            release.addDependency(this.releases.get(dep) as Release, allDependencies[dep]);
          }
        }
      });

    return this;
  }

  async createOrUpdatePR({ options, commandConfig }: { options: Record<string, any>; commandConfig: any }) {
    await execute('git add .');
    await execute('git commit -m "chore: bump versions & update changelogs"');
    const currentBranch = (await execute('git rev-parse --abbrev-ref HEAD')).stdout;
    await execute(`git push --set-upstream origin ${currentBranch}`);
    if (options.pr && options.pr !== true) {
      log(`Updating PR: ${options.pr}`);
      const prUrl = await execute(
        `gh pr edit ${options.pr} --add-label "autorelease: ready" --remove-label "autorelease: pending" --body "${this.changelog}"`,
      ).then((x) => x.stdout);
      log(`PR updated: ${prUrl}`);
    } else if (options.pr) {
      const exists = await execute(
        `gh pr list --state open -B ${commandConfig.targetBranch} -H ${currentBranch} --label="autorelease: pending" --json number,title,headRefName,baseRefName,labels | jq`,
      ).then((x) => x.stdout);
      const pr = JSON.parse(exists);
      if (pr.length) {
        log(`Updating PR: ${pr[0].number}`);
        const prUrl = await execute(
          `gh pr edit ${pr[0].number} --add-label "autorelease: ready"  --remove-label "autorelease: pending" --body "${this.changelog}"`,
        ).then((x) => x.stdout);
        log(`PR updated: ${prUrl}`);
      } else {
        const pullRequest = await execute(
          `gh pr create -B "${commandConfig.targetBranch}" --title "chore: release ${Array.from(this.releases.values())
            .map((release) => release.json.name + '@' + release.next)
            .join(', ')}" --body "${this.changelog}" --label "autorelease: ready"`,
        ).then((x) => x.stdout);
        log(`New PR created: ${pullRequest}`);
      }
    }
  }

  applyBumps() {
    for (const release of this.releases.values()) {
      const json = readJson(`${release.path}/package.json`);
      json.version = release.next;
      writeJson(`${release.path}/package.json`, json);
    }
    return this;
  }

  updateChangelogs() {
    for (const release of this.releases.values()) {
      if (!fs.existsSync(`${release.path}/CHANGELOG.md`)) {
        fs.writeFileSync(`${release.path}/CHANGELOG.md`, release.changelog);
        return this;
      }
      const changelog = fs.readFileSync(`${release.path}/CHANGELOG.md`).toString();
      fs.writeFileSync(`${release.path}/CHANGELOG.md`, `${release.changelog}\n${changelog}`);
    }

    return this;
  }

  resetChangelogs() {
    for (const release of this.releases.values()) {
      if (!fs.existsSync(`${release.path}/CHANGELOG.md`)) {
        fs.writeFileSync(`${release.path}/CHANGELOG.md`, '');
        return;
      }
      let changelog = fs.readFileSync(`${release.path}/CHANGELOG.md`).toString();
      changelog = changelog.replace(release.changelog + '\n', '');
      fs.writeFileSync(`${release.path}/CHANGELOG.md`, changelog);
    }

    return this;
  }

  save() {
    fs.writeFileSync(
      this.path,
      JSON.stringify(
        {
          releases: [...this.releases.values()].map((release) => {
            return {
              path: release.path,
              current: release.current,
              next: release.next,
              name: release.name,
              changelog: release.changelog,
              dependencies: release.dependencies.map((dep) => {
                return {
                  previous: dep.range,
                  path: dep.path,
                  current: dep.current,
                  next: dep.next,
                  name: dep.name,
                };
              }),
            };
          }),
        },
        null,
        2,
      ),
    );

    return this;
  }

  async generateChangelog({
    year,
    month,
    day,
    commandConfig,
  }: {
    year: string;
    month: string;
    day: string;
    commandConfig: any;
  }) {
    log('Generating changelog');
    await Promise.all(
      Array.from(this.releases.values()).map(async (release) =>
        release.generateChangelog({ year, month, day, commandConfig }),
      ),
    );

    this.changelog = '';
    this.changelog += `${commandConfig.pullRequest.header}
---
`;
    this.releases.forEach((release) => {
      this.changelog += `\n<details><summary>${release.json.name}: ${release.current} > ${release.next}</summary>
${release.changelog}
</details>`;
    });

    await commandConfig.hooks.onChangelog(this);
  }

  async reset() {
    log('Resetting from previous manifest');
    if (this.config?.releases) {
      this.releases = this.config.releases.map((release: any) => {
        release.next = release.current;
        return release;
      });
      this.applyBumps().resetChangelogs();
      this.releases = new Map();
    }
  }
}

export type Bump = 'major' | 'minor' | 'patch';

export class Release {
  name: string;
  path: string;
  range: string = '';
  nextRange: string = '';
  current: string;
  next: string = '';
  changelog: string = '';
  bump: Bump | false = false;
  commits: Commit[] = [];
  dependencies: Release[] = [];
  json: any;
  constructor({ path, name }: { path: string; name: string }) {
    this.path = path;
    this.name = name;
    this.json = readJson(path + '/package.json');
    this.current = this.json.version || '0.0.0';
  }

  addCommit(commit: Commit) {
    this.commits.push(commit);
    if (commit.breaking) this.bump = 'major';
    if (commit.type == 'feat' && this.bump != 'major') this.bump = 'minor';
    if (this.bump == false) this.bump = 'patch';

    this.next = this.computeNewVersion(this.json.version || '0.0.0', this.bump as Bump);
  }

  addDependency(release: Release, range: string) {
    if (release.next != '') {
      if (range === 'workspace:*') {
        release.range = range;
        release.nextRange = release.next;
        this.dependencies.push(release);
        log(
          `${c.bold(c.magenta(this.json.name))}: bumping ${c.green(
            release.json.name,
          )} from workspace to ${formatVersion(release.next, release.bump as Bump)!} [${c.bold(
            c[release.bump === 'major' ? 'red' : release.bump === 'minor' ? 'green' : 'yellow'](release.bump),
          )}]`,
        );
        return;
      }
      if (!/^[\^~]/.test(range as string)) {
        log(
          `${c.bold(c.magenta(this.json.name))}: skipping bump of ${
            release.json.name
          } because version is fixed: ${range}`,
        );
        return;
      }
      if (String(range).startsWith('~') && release.bump == 'patch') {
        release.range = range;
        release.nextRange = `~${release.next}`;
        this.dependencies.push(release);
        log(
          `${c.bold(c.magenta(this.json.name))}: bumping ${c.green(release.json.name)} from ${c.bold(
            c.blue(range),
          )} to ~${formatVersion(release.next, release.bump)} [${c.bold(c['yellow'](release.bump))}]`,
        );
      }
      if (String(range).startsWith('^') && ['minor', 'patch'].includes(release.bump as Bump)) {
        release.range = range;
        release.nextRange = `^${release.next}`;
        this.dependencies.push(release);
        log(
          `${c.bold(c.magenta(this.json.name))}: bumping ${c.green(release.json.name)} from ${c.bold(
            c.blue(range),
          )} to ^${formatVersion(release.next, release.bump as Bump)} [${c.bold(
            c[release.bump === 'major' ? 'red' : release.bump === 'minor' ? 'green' : 'yellow'](release.bump),
          )}]`,
        );
      }
    }
  }

  computeNewVersion(version: string, type: Bump) {
    return version
      .split('.')
      .map(Number)
      .map((v, i, a) => {
        if (type == 'minor' || type == 'major') a[2] = 0;
        if (type == 'major') a[1] = 0;
        if (i == 0 && type == 'major') {
          v++;
        }
        if (i == 1 && type == 'minor') {
          v++;
        }
        if (i == 2 && type == 'patch') {
          v++;
        }
        return v;
      })
      .join('.');
  }

  async generateChangelog({
    year,
    month,
    day,
    commandConfig,
  }: {
    year: string;
    month: string;
    day: string;
    commandConfig: any;
  }) {
    this.changelog = '\n';
    this.changelog += await commandConfig.hooks.generate.header({ release: this, year, month, day, commandConfig });

    const sections = commandConfig.sections.map((section: string) => {
      return {
        section,
        commits: this.commits.filter((commit: Commit) => commit.type === section),
      };
    });
    const others = this.commits.filter((commit: Commit) => !commandConfig.sections.includes(commit.type));
    if (others.length) {
      sections.push({
        section: 'other',
        commits: others,
      });
    }
    sections.forEach((section: { section: string; commits: Commit[] }) => {
      if (!section.commits.length) return;
      if (section.commits?.length) {
        this.changelog += `${commandConfig.pullRequest[section.section as keyof typeof commandConfig.pullRequest]}\n\n`;
        for (const commit of section.commits) {
          this.changelog += `* ${commit.date.toISOString().split('T')[0]} ${commit.message} ([${commit.hash.slice(
            0,
            7,
          )}](https://github.com/${commandConfig.repository}/commit/${commit.hash}))\n`;
        }
        this.changelog += '\n';
      }
    });

    if (this.dependencies.length) {
      this.changelog += `${commandConfig.pullRequest.dependencies}\n\n`;
      this.changelog += '* The following workspace dependencies were updated\n';
      for (const [dep, current, next] of this.dependencies.map((dep) => [dep.name, dep.current, dep.next])) {
        this.changelog += `    * ${dep} bumped from ${current} to ${next}\n`;
      }
    }

    return this.changelog;
  }
}

export class Commit {
  hash: string;
  date: Date;
  message: string;
  scope: string;
  type: string;
  breaking: boolean;
  files: string[] = [];

  constructor({ hash, timestamp, message }: { hash: string; timestamp: string; message: string }) {
    this.hash = hash;
    this.date = new Date(Number(timestamp) * 1000);
    this.message = message;
    this.scope = message.split('(')[1]?.split(')')[0];
    this.type = message.split(':')[0].replace(`(${this.scope})`, '');
    this.breaking = this.type.includes('!');
    if (this.breaking) {
      this.type = this.type.replace('!', '');
    }
  }

  async getFiles(hash: string) {
    this.files = await execute(
      `git diff-tree --no-commit-id --name-only --line-prefix=\`git rev-parse --show-toplevel\`/ -r ${hash}`,
    ).then((x) => x.stdout.split('\n').filter((x) => x));
  }

  checkImpact(scan: string[], hasRootPackage: boolean, releases: Map<string, Release>) {
    const packagesFiles = this.files.filter((file) => scan.some((p) => file.startsWith(p)));
    if (!packagesFiles.length && hasRootPackage) {
      releases.get('@root')?.addCommit(this);
    } else {
      const packages = new Map<string, { name: string; path: string }>();
      for (const file of packagesFiles) {
        const pkg = scan.find((p) => file.startsWith(p));
        const pkgRoot = pkg?.split('/').pop();
        const pkgFile = file.replace(pkg + '/', '');
        const pkgName = pkgFile.split('/')[0];
        if (!packages.has(pkgName)) {
          packages.set(pkgName, {
            path: `${pkgRoot}/${pkgName}`,
            name: pkgName,
          });
        }
      }
      packages.forEach((pkg) => {
        if (!releases.has(pkg.name)) {
          releases.set(pkg.name, new Release(pkg));
        }
        releases.get(pkg.name)?.addCommit(this);
      });
    }
  }
}
