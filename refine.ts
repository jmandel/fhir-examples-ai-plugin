import { OpenAI } from "https://deno.land/x/openai@1.3.4/mod.ts";
import {
  Application,
  Router,
  send,
} from "https://deno.land/x/oak@v11.1.0/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const app = new Application();
app.use(async (ctx, next) => {
  console.log(ctx.request)
  await next();
});

app.use(oakCors()); // Enable CORS for All Routes

const router = new Router();

const brokenExample = { resourceType: "Patient", gender: "woman" };
const fixedExample = { resourceType: "Patient", gender: "female" };

const practice = [
  {
    role: "system",
    content:
      "You are a helpful assistant that fixes FHIR resources based on validation results. Your output always begins with `{`. Your output is a JSON string with no preamble or commentary.",
  },
  {
    role: "user",
    content: `## Description
Female patient
`,
  },
  {
    role: "user",
    content: JSON.stringify(brokenExample, null, 2),
  },
  {
    role: "user",
    content:
      "[3, 19] Patient.gender: Error - The value provided ('woman') is not in the value set 'AdministrativeGender' (http://hl7.org/fhir/ValueSet/administrative-gender|5.0.0), and a code is required from this value set) (error message = Unknown Code 'woman' in the system 'http://hl7.org/fhir/administrative-gender'; None of the provided codes [http://hl7.org/fhir/administrative-gender#woman] are in the value set 'http://hl7.org/fhir/ValueSet/administrative-gender')",
  },
  {
    role: "assistant",
    content: JSON.stringify(fixedExample, null, 2),
  },
];

const api = new OpenAI(Deno.env.get("OPENAI_API_KEY")!);

const validate = async (resource: any) => {
  const inputPath = await Deno.makeTempFile();
  const outputPath = await Deno.makeTempFile();

  console.log("Set up", resource);

  Deno.writeTextFileSync(inputPath, resource);
  const command = new Deno.Command("java", {
    args: [
      "-jar",
      "./validator_cli.jar",
      "-version",
      "4.0.1",
      inputPath,
      "-output",
      outputPath,
      "-output-style",
      "compact",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  console.log(
    "OUT",
    output,
    new TextDecoder().decode(output.stdout),
    "\nERR",
    new TextDecoder().decode(output.stderr)
  );
  let result = Deno.readTextFileSync(outputPath)
    .split("\n")
    .slice(3)
    .join("\n");

  if (result.includes("http://unitsofmeasure.org")) {
    result += "You can place ucum annocations in {curly braces} to make them unitless."
  }
  Deno.remove(inputPath);
  Deno.remove(outputPath);
  console.log("RES", result);
  return result;
};

interface RefineInput {
  background: string;
  description: string;
  resource: any;
  vocabulary?: any;
  attempts?: number;
}
const refineFhir = async ({
  resource,
  vocabulary,
  description,
  attempts = 3,
}: RefineInput) => {
  let r = JSON.stringify(resource);
  let v;

  for (let i = 0; i < attempts; i++) {

    try {
      r = JSON.stringify(JSON.parse(r), null, 2)
    } catch {
      console.error("could not parse", r)
    }

    v = await validate(r);
    if (!v.match(/error|fatal/i)) {
      console.log("No errors left");
      break;
    }
    const turn = [
      {
        role: "user",
        content: `Now let's start another example.\n## Description\n${description}\n## Vocabulary\n${JSON.stringify(vocabulary, null, 2)}`,
      },
      {
        role: "user",
        content: JSON.stringify(r, null, 2),
      },
      {
        role: "user",
        content: v,
      },
      {
        role: "assistant",
        content: "I will now output JSON starting with `{`, no code blocks or commentary."
      }
    ];

    console.log("Chat completion for", turn);
    const refined = await api.createChatCompletion({
      model: "gpt-3.5-turbo",
      temperature: 0.3,
      messages: [...practice, ...turn] as any,
    });
    const nextR = JSON.stringify(JSON.parse(refined.choices[0].message.content), null, 2)

    console.log("Refined to", r);
    if (nextR === r) {
      break;
    }
    r = nextR;
  }
  return [r, v];
};

router.post("/fhir/refine", async (context) => {
  const b = await context.request.body().value;
  const [j, codings] = filterJSON(b.resource);

  const vocabulary = await Promise.all(codings.map(r => fetch(`https://vocab-tool.fly.dev/$lookup-code?system=${encodeURIComponent(r.system)}&display=${encodeURIComponent(r.display)}`).then(r => r.json())))
  console.log("vocabulary", vocabulary)


  const d = b.description;

  const { request, response } = context;
  console.log("REfine", d, j)

  let [rrefined, validation] = await refineFhir({
    background: "",
    vocabulary,
    description: d,
    resource: j,
  });

  // try {
  //   rrefined = JSON.parse(rrefined)
  // } catch {}

  response.body = {
    instructions: "Review the output, incorporating vocabulary items into your Codings as needed. Also fix any validation  issues discovered.",
    refinedOutput: rrefined,
    vocabulary: JSON.stringify(vocabulary, null, 2),
    validationResult:  validation
  };
});

app.use(router.routes());

// const wellKnownRouter
app.use(async (context, next) => {
  try {
    await context.send({
      root: `${Deno.cwd()}/public`,
      hidden: true,
    });
  } catch {
    await next();
  }
});

app.use(router.allowedMethods());

const port = 4444; // Choose any port number you prefer
console.log(`Server is running on http://localhost:${port}/`);
await app.listen({ port });


function filterJSON(obj, systems: string[] = ["http://www.nlm.nih.gov/research/umls/rxnorm", "http://loinc.org", "http://snomed.info/sct"]) {
  let redactions = [];
  let filteredObj = Array.isArray(obj) ? [] : {};

  for (let prop in obj) {
    if (obj[prop] && typeof obj[prop] === 'object') {
      if (Array.isArray(obj[prop]) && prop === 'coding') {
        obj[prop].forEach(item => {
          if (item.code && systems.includes(item.system)) {
            let clonedItem = { ...item };
            redactions.push({...clonedItem});
            delete clonedItem.code;
            delete clonedItem.display;
            filteredObj[prop] = filteredObj[prop] || [];
            filteredObj[prop].push(clonedItem);
          } else {
            filteredObj[prop] = filteredObj[prop] || [];
            filteredObj[prop].push(item);
          }
        });
      } else {
        let [filteredNestedObj, nestedRedactions] = filterJSON(obj[prop]);
        redactions = redactions.concat(nestedRedactions);
        if (Array.isArray(obj)) {
          filteredObj.push(filteredNestedObj);
        } else {
          filteredObj[prop] = filteredNestedObj;
        }
      }
    } else {
      if (Array.isArray(obj)) {
        filteredObj.push(obj[prop]);
      } else {
        filteredObj[prop] = obj[prop];
      }
    }
  }

  return [filteredObj, redactions];
}

