import { Argv } from 'yargs'
import { $, cd, nothrow } from 'zx'
import { encrypt } from '../common/crypt'
import { OtomiDebugger, terminal } from '../common/debug'
import { env } from '../common/envalid'
import { hfValues } from '../common/hf'
import { cleanupHandler, otomi, PrepareEnvironmentOptions } from '../common/setup'
import { currDir, getFilename, gitPush, setParsedArgs } from '../common/utils'
import { Arguments as HelmArgs } from '../common/yargs-opts'
import { Arguments as DroneArgs, genDrone } from './gen-drone'
import { validateValues } from './validate-values'

const cmdName = getFilename(import.meta.url)
let debug: OtomiDebugger

interface Arguments extends HelmArgs, DroneArgs {}

/* eslint-disable no-useless-return */
const cleanup = (argv: Arguments): void => {
  if (argv.skipCleanup) return
}
/* eslint-enable no-useless-return */

const setup = async (argv: Arguments, options?: PrepareEnvironmentOptions): Promise<void> => {
  if (argv._[0] === cmdName) cleanupHandler(() => cleanup(argv))
  debug = terminal(cmdName)

  if (options) await otomi.prepareEnvironment(options)
  otomi.exitIfInCore(cmdName)
}

export const preCommit = async (argv: DroneArgs): Promise<void> => {
  const pcDebug = terminal('Pre Commit')
  pcDebug.info('Check for cluster diffs')
  await nothrow($`git config diff.sopsdiffer.textconv "sops -d"`)
  const settingsDiff = (await $`git diff env/settings.yaml`).stdout.trim()
  const secretDiff = (await $`git diff env/secrets.settings.yaml`).stdout.trim()

  const versionChanges = settingsDiff.includes('+    version:')
  const secretSlackChanges = secretDiff.includes('+        url: https://hooks.slack.com/')
  const secretMsTeamsLowPrioChanges = secretDiff.includes('+        lowPrio: https://')
  const secretMsTeamsHighPrioChanges = secretDiff.includes('+        highPrio: https://')
  if (versionChanges || secretSlackChanges || secretMsTeamsLowPrioChanges || secretMsTeamsHighPrioChanges)
    await genDrone(argv)
}

export const commit = async (argv: Arguments, options?: PrepareEnvironmentOptions): Promise<void> => {
  await setup(argv, options)

  await validateValues(argv)

  debug.info('Preparing values')

  const currDirVal = await currDir()
  cd(env.ENV_DIR)

  const vals = await hfValues()
  const clusterDomain = vals.cluster.domainSuffix ?? vals.cluster.apiName

  preCommit(argv)
  await encrypt()
  debug.info('Do commit')
  await $`git add -A`
  await $`git commit -m 'otomi commit' --no-verify`

  debug.info('Pulling latest values')
  try {
    await $`git pull`
  } catch (error) {
    debug.error(
      `When trying to pull from ${clusterDomain} merge conflicts occured\nPlease resolve these and run \`otomi commit\` again.`,
    )
    process.exit(1)
  }
  let healthUrl
  let branch
  if (!vals.charts?.gitea?.enabled) {
    healthUrl = `gitea.${clusterDomain}`
    branch = 'main'
  } else {
    // @ts-ignore
    branch = vals.charts!['otomi-api']!.git!.branch ?? 'main'
  }

  try {
    const stage = vals.charts?.['cert-manager']?.stage === 'staging'
    await $`git remote show origin`
    await gitPush(branch, stage, healthUrl)
    debug.log('Successfully pushed the updated values')
  } catch (error) {
    debug.error(error.stderr)
    debug.error('Pushing the values failed, please read the above error message and manually try again')
    process.exit(1)
  } finally {
    cd(currDirVal)
  }
}

export const module = {
  command: cmdName,
  // As discussed: https://otomi.slack.com/archives/C011D78FP47/p1623843840012900
  describe: 'Execute wrapper for generate pipelines -> git commit changed files',
  builder: (parser: Argv): Argv => parser,

  handler: async (argv: Arguments): Promise<void> => {
    setParsedArgs(argv)
    await commit(argv, { skipKubeContextCheck: true })
  },
}

export default module
