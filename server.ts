import * as fs from "https://deno.land/std@0.155.0/fs/mod.ts";
import { run } from "https://deno.land/x/run_simple@1.1.0/mod.ts";
import { Application, Router } from "https://deno.land/x/oak@v11.1.0/mod.ts";
import { RouterContext } from "https://deno.land/x/oak@v11.1.0/router.ts";
import { assert } from "https://deno.land/std@0.152.0/testing/asserts.ts";

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

if (!await fs.exists("./mc-translations-backport-data")) {
    await run(["git", "clone", "https://github.com/arthurbambou/mc-translations-backport-data.git"])
}

if (!await fs.exists("./data")) {
    await Deno.mkdir("./data")
}


let diffMap: AMap = {}
let versionToAssets: AMap = {}
let theMeta: MCMeta;

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

await app.listen({ port: 8000 });

async function updateDatabase() {
    try {
        const currentCommit = await run(["git", "rev-parse", "--short", "HEAD"], {cwd: "./mc-translations-backport-data"})
        await run(["git", "pull"], {cwd: "./mc-translations-backport-data"})
        const newCommit = await run(["git", "rev-parse", "--short", "HEAD"], {cwd: "./mc-translations-backport-data"})

        if (currentCommit != newCommit) {
            await fs.emptyDir("./data")

            diffMap = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/diff_info.json")))
            versionToAssets = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/translations_info.json")))
            theMeta = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/pack.mcmeta")))
        }
    } catch(e) {
        console.error(e)

        if (!diffMap || !versionToAssets || !theMeta) {
            await fs.emptyDir("./data")

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

    if (!await fs.exists(`./data/${version}`)) {
        await Deno.mkdir(`./data/${version}`)
    }

    if (!await fs.exists(`./data/${version}/${code}.json`)) {
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

            if (!await fs.exists(`./data/${entry.child}`)) {
                await Deno.mkdir(`./data/${entry.child}`)
            }

            if (await fs.exists(childPath)) {
                continue
            }

            if (!entry.parent) {
                const langPath = "./mc-translations-backport-data/translated_original/" + versionToAssets[entry.child] + "/" + code + ".json";

                if (await fs.exists(langPath)) {
                    await Deno.writeFile(childPath, await Deno.readFile(langPath));
                }
            } else {
                const diffManifest: DiffFile = JSON.parse(decoder.decode(await Deno.readFile("./mc-translations-backport-data/diff/" + entry.parent + "#" + entry.child + ".json")));

                const newerLangJSON: AMap = JSON.parse(decoder.decode(await Deno.readFile(parentPath)))
                const langPath = "./mc-translations-backport-data/translated_original/" + versionToAssets[entry.child] + "/" + code + ".json";

                let langPathJSON: Record<string, string>;

                if (await fs.exists(langPath)) {
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