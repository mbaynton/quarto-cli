import { Command } from "cliffy/command/mod.ts";
import { Configuration, configuration } from "../common/config.ts";
import { parseLogLevel } from "../common/logger.ts";

const kLogLevel = "logLevel";

export function packageCommand(run: (config: Configuration) => void) {
    return new Command().action((args) => {
        const logLevel = args[kLogLevel];
        const config = configuration(parseLogLevel(logLevel));

        config.log.info("Using configuration:");
        config.log.info(config);
        config.log.info("");

        run(config)
    });
}