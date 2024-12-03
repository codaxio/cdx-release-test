import { c, execute, readJson, writeJson } from '@codaxio/cdx';
import fs from 'fs';

import { log, Release } from './commands/release';

export default {
  release: {
    repository: 'codaxio/cdx-release-test',
    scan: ['packages'],
    hooks: {
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
            `echo aws ecr describe-images --repository-name="usdn-backend" --image-ids=imageTag="${imageTag}" 2> /dev/null`,
          ).then((x) => x.stdout.split('\n').filter((x) => x));
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
          console.log(`Update ${release.name} dependencies`, json);
          writeJson(`${release.path}/package.json`, json);
        });

        console.log("Bump dependencies", await execute(`pnpm install`))
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
        console.log(await execute(`git status`));
        console.log(await execute(`pnpm install`));
        await execute(`git add .`);
        await execute(`git commit -m "chore: update internal dependencies"`);
        await execute(`git push`);
      },
    },
  },
};
