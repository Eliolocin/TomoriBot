// locales/ja/commands.ts
// Assembler: edit the individual files in commands/ instead.

import learn from "./commands/learn";
import speech from "./commands/speech";
import choices from "./commands/choices";
import stPreset from "./commands/st-preset";
import tool from "./commands/tool";
import status from "./commands/status";
import data from "./commands/data";
import persona from "./commands/persona";
import help from "./commands/help";
import legal from "./commands/legal";
import novelai from "./commands/novelai";
import impersonate from "./commands/impersonate";
import conditioning from "./commands/conditioning";
import reward from "./commands/reward";
import punish from "./commands/punish";
import support from "./commands/support";
import contribute from "./commands/contribute";
import donate from "./commands/donate";
import nsfw from "./commands/nsfw";
import openrouter from "./commands/openrouter";
import config from "./commands/config";
import optionalKey from "./commands/optional-key";
import server from "./commands/server";
import personal from "./commands/personal";
import scheduledTask from "./commands/scheduled-task";
import memory from "./commands/memory";
import teach from "./commands/teach";
import forget from "./commands/forget";
import generate from "./commands/generate";
import model from "./commands/model";
import mcps from "./commands/mcps";
import capabilities from "./commands/capabilities";
import provider from "./commands/provider";
import update from "./commands/update";
import stats from "./commands/stats";
import ping from "./commands/ping";
import comment from "./commands/comment";
import kill from "./commands/kill";
import refresh from "./commands/refresh";
import expressions from "./commands/expressions";
import matrix from "./commands/matrix";
import respond from "./commands/respond";
import shared from "./commands/shared";
import nuke from "./commands/nuke";
import setup from "./commands/setup";
import compact from "./commands/compact";
import providers from "./commands/providers";

export default {
  commands: {
    ...providers,
    ...learn,
    ...speech,
    ...choices,
    ...stPreset,
    ...tool,
    ...status,
    ...data,
    ...persona,
    ...help,
    ...legal,
    ...novelai,
    ...impersonate,
    ...conditioning,
    ...reward,
    ...punish,
    ...support,
    ...contribute,
    ...donate,
    ...nsfw,
    ...openrouter,
    ...config,
    ...optionalKey,
    ...server,
    ...personal,
    ...scheduledTask,
    ...memory,
    ...teach,
    ...forget,
    ...generate,
    ...model,
    ...mcps,
    ...capabilities,
    ...provider,
    ...update,
    ...stats,
    ...ping,
    ...comment,
    ...kill,
    ...refresh,
    ...expressions,
    ...matrix,
    ...respond,
    ...shared,
    ...nuke,
    ...setup,
    ...compact,
  },
};
