import { exists } from "https://deno.land/std@0.192.0/fs/exists.ts";
import { emptyDir } from "https://deno.land/std@0.192.0/fs/empty_dir.ts";
import { run } from "https://deno.land/x/run_simple@2.1.0/mod.ts";
import { Application, Router } from "https://deno.land/x/oak@v12.5.0/mod.ts";
import { RouterContext } from "https://deno.land/x/oak@v12.5.0/router.ts";
import { assert } from "https://deno.land/std@0.192.0/testing/asserts.ts";

type AMap = Record<string, string>;
type DiffFile = {
    removed: string[],
    changed: string[],
    added: string[],
    valueMoved: Record<string, string[]>
};

type LangEntry = {
    name: string,
    region: string,
    bidirectional: boolean
};
type MCMeta = {
    language: Record<string, LangEntry>
};

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

if (!await exists("./mc-translations-backport-data")) {
    await run(["git", "clone", "https://github.com/thecatcore/mc-translations-backport-data.git"])
}

if (!await exists("./data")) {
    await Deno.mkdir("./data")
}


let diffMap: AMap = {}
let versionToAssets: AMap = {}
let theMeta: MCMeta;
let firstStart = true;

setInterval(async () => {
    await updateDatabase()
}, 8.64e+7)

await updateDatabase()

const router = new Router();
router
    .get("/", (context) => {
        context.response.body = "Hello world!";
    })
    .get("/lang/:version/:code", async (context) => {
        await answerRequest(context);
    })
    .get("/mcmeta", (context) => {
        context.response.body = theMeta;
    });

const app = new Application();
app.use(router.routes());
app.use(router.allowedMethods());

await app.listen({ port: 8005 });

async function updateDatabase() {
    try {
        await run(["git", "fetch"])
        await run(["git", "reset", "--hard", "HEAD"])
        await run(["git", "merge", "'@{u}'"])
    } catch (e) {
        console.log("failed to update server repo")
        console.error(e)
    }

    try {
        const currentCommit = await run(["git", "rev-parse", "--short", "HEAD"], {cwd: "./mc-translations-backport-data"})
        await run(["git", "pull"], {cwd: "./mc-translations-backport-data"})
        const newCommit = await run(["git", "rev-parse", "--short", "HEAD"], {cwd: "./mc-translations-backport-data"})

        if (currentCommit != newCommit || firstStart) {
            await emptyDir("./data")

            diffMap = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/diff_info.json")))
            versionToAssets = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/translations_info.json")))
            theMeta = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/pack.mcmeta")))
            firstStart = false;
        }
    } catch(e) {
        console.error(e)

        if (!diffMap || !versionToAssets || !theMeta) {
            await emptyDir("./data")

            diffMap = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/diff_info.json")))
            versionToAssets = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/translations_info.json")))
            theMeta = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/pack.mcmeta")))
        }
    }
}

async function answerRequest(context: RouterContext<"/lang/:version/:code",{ version: string; }&{ code: string; }&Record<string|number,string|undefined>,Record<string,any>>) {
    const params = context?.params;
    const version = params?.version
    const code = params?.code

    if (!await exists(`./data/${version}`)) {
        await Deno.mkdir(`./data/${version}`)
    }

    if (!await exists(`./data/${version}/${code}.json`)) {
        const todoMap: Array<{
            parent: string,
            child: string
        }> = []

        let theVersion = version;

        while(theVersion) {
            if (Object.hasOwn(diffMap, theVersion)) {
                todoMap.push({
                    parent: diffMap[theVersion],
                    child: theVersion
                })
                theVersion = diffMap[theVersion]
            } else {
                todoMap.push({
                    parent: "",
                    child: theVersion
                })
                theVersion = ""
            }
        }

        todoMap.reverse()

        while (todoMap.length > 0) {
            const entry = todoMap.shift()
            assert(entry != undefined, "ohno");
            const childPath = `./data/${entry.child}/${code}.json`
            const parentPath = `./data/${entry.parent}/${code}.json`

            if (!await exists(`./data/${entry.child}`)) {
                await Deno.mkdir(`./data/${entry.child}`)
            }

            if (await exists(childPath)) {
                continue
            }

            if (!entry.parent) {
                const langPath = "./mc-translations-backport-data/translated_original/" + versionToAssets[entry.child] + "/" + code + ".json";

                if (await exists(langPath)) {
                    await Deno.writeFile(childPath, await Deno.readFile(langPath));
                }
            } else {
                const diffManifest: DiffFile = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/diff/" + entry.parent + "#" + entry.child + ".json")));

                const newerLangJSON: AMap = JSON.parse(decoder.decode(await Deno.readFile(parentPath)))
                const langPath = "./mc-translations-backport-data/translated_original/" + versionToAssets[entry.child] + "/" + code + ".json";

                let langPathJSON: Record<string, string>;

                if (await exists(langPath)) {
                    langPathJSON = <Record<string, string>><unknown>JSON.parse(decoder.decode(await Deno.readFile(langPath)));
                } else {
                    langPathJSON = <Record<string, string>><unknown>JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/original/" + entry.child + ".json")));
                }

                const theJson: Record<string, string> = {};

                // Move
                for (const key in diffManifest.valueMoved) {
                    const newKeys = diffManifest.valueMoved[key];

                    newKeys.forEach(newKey => {
                        theJson[newKey] = newerLangJSON[key];
                    });
                }

                // Add
                diffManifest.added.forEach(key => {
                    if (!Object.hasOwn(theJson, key)) {
                        theJson[key] = langPathJSON[key];
                    }
                });

                // Change
                diffManifest.changed.forEach(key => {
                    if (!Object.hasOwn(theJson, key)) {
                        theJson[key] = langPathJSON[key];
                    }
                });

                // Remove
                for (const key in newerLangJSON) {
                    const val = newerLangJSON[key];

                    if (diffManifest.removed.includes(key) || Object.hasOwn(theJson, key)) continue;

                    theJson[key] = val;
                }

                const theJASON = JSON.stringify(theJson, undefined, 4);
                await Deno.writeFile(childPath, encoder.encode(theJASON));
            }
        }
    }

    const theFile = await Deno.readFile(`./data/${version}/${code}.json`)
    context.response.body = JSON.parse(decoder.decode(theFile))
}
