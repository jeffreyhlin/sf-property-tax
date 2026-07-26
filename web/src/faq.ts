export type FaqItem = { q: string; a: string };

export const FAQ: FaqItem[] = [
  {
    "q": "What does this map show?",
    "a": "Every parcel in San Francisco, about 207,000 of them, colored by the gap between what it's taxed on and what it's probably worth. Under California's Prop 13, a property's taxed value is frozen near its last sale price, so a home bought in 1985 can pay a tenth of what its neighbor pays. The map estimates that gap for each parcel and translates it into dollars of tax per year."
  },
  {
    "q": "What does \"transferred without reassessment\" mean?",
    "a": "The tax roll shows the property changed hands, but its taxable value never reset to market. Whatever the reason, the old low basis carried forward, so the new owner inherited the discount. Several things cause this. Some are family, spousal, or trust transfers, which California law exempts from reassessment. Others are ordinary sales where the price simply came in at or below the existing assessment, foreclosures, transfers between business entities, or affordable-housing partnerships whose assessments are restricted by regulation. The label states the pattern, not the reason. Open a parcel to see the actual recorded deeds and parties."
  },
  {
    "q": "How do you figure that out without seeing the deeds?",
    "a": "From how the assessment behaves. Prop 13 only lets a taxed value grow about 2% per year until a sale resets it, so when the tax roll shows a new sale date and the taxed value jumps more than 25%, that was a market sale. When the roll shows a new sale date but the taxed value just keeps growing at the capped rate, the transfer did not trigger a reassessment. That is all the assessment data can tell us. It cannot tell us who the parties were or why the value held, which is why the site also pulls the recorded deeds from the county for the parcel you are looking at."
  },
  {
    "q": "So is that label a fact?",
    "a": "It is a fact about the assessment, not about the people. We checked it: for the top parcels flagged this way, we pulled the real recorded deeds and found only about 11% were genuine family or trust transfers. Roughly 84% were arm's-length events including foreclosures, developer sales, corporate relocations, and affordable-housing partnership transfers. The reason is that our market estimate often runs above the actual sale price, so a real sale that did reset, to a lower real price, can look like it never reset. This is why the label no longer claims a family transfer, and why each affected parcel carries a warning. The dollar figures are unaffected, since they come from assessed versus estimated market value."
  },
  {
    "q": "How do you estimate market value?",
    "a": "We look at similar properties nearby that sold recently. When a property is reassessed at sale, its new taxed value is roughly its sale price, so we take the median price per square foot of same-type properties in the same neighborhood that reset in the last 3 years, and multiply by the building's square footage. Homes are compared to homes, apartment buildings to apartment buildings."
  },
  {
    "q": "How accurate is that?",
    "a": "It's a rough estimate, not an appraisal. Against actual recent sales, our estimates are off by about 18% at the median (validated against ~11,000 actual sales 2022-2025; details in our methodology) on average. They're least reliable for unusual properties, large multi-unit buildings, and rent-controlled buildings, so treat any single number as a ballpark."
  },
  {
    "q": "Where do the owner names come from?",
    "a": "From the San Francisco Assessor-Recorder's public index of recorded documents, which anyone can search by block and lot. When you open a parcel, this site queries that index and lists each recorded document with its date, type, and the grantor and grantee names exactly as the county recorded them. Names are not in DataSF's open data, which is why the assessed values and the deed records come from two different places. Every name shown is a public record, and each parcel links to the county index so you can verify it yourself."
  },
  {
    "q": "How do Prop 13 and the family transfer rules actually work?",
    "a": "Prop 13, passed in 1978, changed how California taxes property. Instead of taxing what your property is worth today, it taxes what you paid for it, plus at most 2% growth per year. Property values in California have grown far faster than 2%, so the longer you hold, the bigger your discount. The taxed value only resets to market when the property sells.\n\nNormally a sale includes inheritance, so your kids would face a big tax jump when they inherit the house. Prop 58 (1986) removed that for parent-child transfers, and Prop 193 (1996) extended it to grandparents when the parents are deceased, letting the low taxed value pass down with the property. Prop 19 (2021) narrowed this: the child now has to live in the home, and only the first $1M or so of the discount carries over. Transfers before 2021 kept the old, more generous rules."
  },
  {
    "q": "What's your privacy stance?",
    "a": "This site shows addresses, taxed values, estimates, and the grantor and grantee names on recorded deeds. All of it is public record. We publish it because who benefits from Prop 13, and by how much, is a public policy question, and because ownership recorded with the county has been public for as long as counties have kept deeds. We aim at the system and at the scale of the subsidy, not at any one household, and we do not add anything the county has not already published: no phone numbers, no emails, no mailing addresses, no linking of one owner across properties."
  },
  {
    "q": "Can I get my property removed?",
    "a": "Names on recorded deeds are public record and this site reproduces them as recorded, so it does not remove them. If something here is wrong, though, we do want to fix it: a misparsed name, a parcel matched to the wrong records, or a transfer we have mislabeled. Open an issue on the project's GitHub repository with the parcel and what looks wrong, and it will be corrected."
  },
  {
    "q": "Where does the data come from, and how often does it update?",
    "a": "Three sources. Two DataSF open datasets provide the numbers: the Assessor's historical secured tax rolls (2007 to present) and the city's parcel map. The Assessor-Recorder's public index of recorded documents provides the deed history and names. The map covers all of San Francisco, about 207,000 parcels. The assessor roll is published once a year after the roll closes, and the site is rebuilt when a new roll lands."
  },
  {
    "q": "Is this legal?",
    "a": "Yes. Assessment rolls are public records under California law, and DataSF publishes these datasets openly for anyone to use. We add analysis on top, and we don't publish anything the city hasn't already released."
  },
  {
    "q": "Is it fair to publish this?",
    "a": "People disagree, and that's part of why the site exists. One view: these are public records about a tax system that shifts billions between neighbors, and you can't debate a policy you can't see. Another view: individual households didn't design Prop 13 and shouldn't be singled out for using it legally. We try to present the numbers neutrally, label inferences as inferences, and give individuals a way to opt out."
  }
];
