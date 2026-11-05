# Research notes: AI writing patterns, detection, and what this tool does about them

Short notes from the reading done before designing the prompts. These are conceptual; the tool does not implement any detector or any detector-evasion logic.

## How AI-text classifiers are built and evaluated

Two families are in use. Statistical detectors score text by how predictable it is to a language model (perplexity) and how much that predictability varies from sentence to sentence (burstiness, often the variance of per-sentence perplexity). Low perplexity and low burstiness push a text towards an "AI" label. Commercial tools generally layer a fine-tuned transformer classifier on top, trained on paired human-written and model-written documents, and are evaluated on held-out pairs. Published accuracy figures vary widely between vendor claims and independent studies.

## Reliability problems

- Independent evaluations find detectors unreliable in practice, in some settings only marginally better than chance. Vendor accuracy claims are not reproducible without the vendor's test set.
- False positives cluster on writers whose prose is predictable for benign reasons: non-native English writers, formal or technical registers, standardised formats such as abstracts and legal text. One widely cited study reported very high false-positive rates on essays by non-native writers.
- Short passages give noisy scores; both signals are statistical estimates.
- Light paraphrasing defeats both classifiers and watermarks, which is why scores should never be treated as proof of authorship.

## What makes generic model writing sound generic

Surveys of the linguistic literature (for example Terčon and Dobrovoljc's 2025 survey, arXiv 2510.05136) and corpus studies report consistent differences between model output and human writing:

- A more formal, impersonal style: more nouns, determiners and prepositions, fewer adjectives and adverbs, less first person.
- Lower lexical diversity and smaller effective vocabulary, with more repeated words and phrases.
- Lower syntactic diversity: sentences of similar shape and length, and paragraphs built on the same template.
- Instruction-tuned models show less diversity than earlier base models, and the effect is strongest for vocabulary. Humans differ more from one another than any single model does from the "average" writer. (Reported in a 2026 ACL paper on diversity decline in newer models; see also Kendro, Maloney and Jarvis on lexical diversity across ChatGPT, Claude and Bard, and Martínez et al., arXiv 2402.15518, on how ChatGPT's lexical richness depends on version, sampling parameters and assigned role.)

At the discourse level the familiar habits follow from the same cause, a model regressing to the mean of its training distribution: announce-then-summarise paragraphs, reflexive triplets and balanced pairs, stock transitions, vocabulary upgrades ("utilize", "leverage", "robust", "delve"), hedges and qualifiers added for safety, and headings or bullets imposed on content that did not need them.

## How human writing varies

Human prose varies with the writer's background, how well they know the subject, their intent, the audience and the medium. An engineer explaining their own work to a colleague writes with specific nouns, uneven sentence lengths that follow the thought rather than a rhythm, plain opinions, occasional asides, and references to concrete things (file names, commands, numbers). The variation is a by-product of meaning, not a style applied on top.

## Design decisions that follow

1. **Preserve variation rather than manufacture it.** The style stage records the author's actual sentence-length range, vocabulary and habits, and the editor is told to match that profile. The editor is also told not to alternate sentence lengths mechanically, insert slang or deliberate irregularities, or add contractions the author did not use. Manufactured burstiness is a detector-evasion trick, not better writing, and it produces exactly the inauthentic prose the user does not want.
2. **Edit, do not rewrite.** A good edit of a decent draft leaves most sentences alone. Every unnecessary rewrite drifts towards the model's own average, which is the generic voice the user is trying to avoid. The reviewer flags unnecessary changes as a problem.
3. **Facts come only from the draft.** The session is reference material for understanding and precision, never a source of new content. This stops the editor from "improving" the write-up with claims the author did not make, the most damaging failure mode for a document that will be read as the author's own account.
4. **Evidence over claims.** The digest labels tool output as evidence and model text as claims, and the context stage is forbidden from upgrading one to the other. The tool itself cross-checks "tests pass" statements against recorded test executions before the model sees anything.
5. **Name the habits, both ways.** The editor prompt lists the generic-LLM habits to avoid, and in the same breath the artificial "humanising" habits to avoid. Both lists are in the prompt file, not the code, so they can be tuned.
6. **A skeptical second pass.** The review stage exists because single-pass rewrites are prone to the very patterns listed above. It checks meaning, inventions, technical accuracy, formality drift and genericness, and can send the draft back once for targeted fixes.
7. **No detector in the loop.** Given the reliability findings, optimising for a detector score would be optimising for noise, and it would conflict with the goal of honest, natural writing. The tool measures nothing about detectability.

## Sources consulted

- Terčon, Dobrovoljc. "Linguistic Characteristics of AI-Generated Text: A Survey." arXiv 2510.05136.
- Martínez et al. "Beware of Words: Evaluating the Lexical Diversity of Conversational LLMs using ChatGPT as Case Study." arXiv 2402.15518, ACM 2024.
- Kendro, Maloney, Jarvis. "Lexical diversity in human- and LLM-generated text." Cognitive Science Society.
- ACL 2026 long paper on declining lexical and syntactic diversity in instruction-tuned models (aclanthology.org/2026.acl-long.1803).
- Explainers on perplexity, burstiness and classifier-based detection, and reports on detector false positives for non-native writers and formal text (casrai.org, dev.to, opendatascience.com, letsdatascience.com, incidentdatabase.ai report 3228).
