# FAQ

## What does this map show?

Every parcel in the covered neighborhoods, colored by the gap between what it's taxed on and what it's probably worth. Under California's Prop 13, a property's taxed value is frozen near its last sale price, so a home bought in 1985 can pay a tenth of what its neighbor pays. The map estimates that gap for each parcel and translates it into dollars of tax per year.

## What does "likely relational transfer" mean?

It means the property changed hands but was not reassessed, which is the signature of a transfer between family members, spouses, or into a trust. California law lets those transfers keep the old, low taxed value instead of resetting to the sale price. So the property passed to someone new, and the tax discount passed with it.

## How do you figure that out without seeing the deeds?

From how the assessment behaves. Prop 13 only lets a taxed value grow about 2% per year until a sale resets it, so when the tax roll shows a new sale date and the taxed value jumps more than 25%, that was a market sale. When the roll shows a new sale date but the taxed value just keeps growing at the capped rate, the transfer was excluded from reassessment, and family, spousal, and trust transfers are by far the most common reason for that.

## So is "likely relational transfer" a fact?

No, it's an inference. We don't have the recorded deeds, so we can't say who transferred to whom or under which exclusion. Some edge cases, like certain co-owner buyouts or legal entity changes, can look the same in the data. That's why the label says "likely."

## How do you estimate market value?

We look at similar properties nearby that sold recently. When a property is reassessed at sale, its new taxed value is roughly its sale price, so we take the median price per square foot of same-type properties in the same neighborhood that reset in the last 3 years, and multiply by the building's square footage. Homes are compared to homes, apartment buildings to apartment buildings.

## How accurate is that?

It's a rough estimate, not an appraisal. Against actual recent sales, our estimates are off by about {{MAPE}} on average. They're least reliable for unusual properties, large multi-unit buildings, and rent-controlled buildings, so treat any single number as a ballpark.

## Why aren't there owner names?

SF's open data excludes them for privacy, so we simply don't have them. Names do exist in public records: the assessment roll with owner names can be requested from the Assessor-Recorder under the California Public Records Act, and deeds are viewable at the Recorder's office. This site sticks to what's published as open data.

## How do Prop 13 and the family transfer rules actually work?

Prop 13, passed in 1978, changed how California taxes property. Instead of taxing what your property is worth today, it taxes what you paid for it, plus at most 2% growth per year. Property values in California have grown far faster than 2%, so the longer you hold, the bigger your discount. The taxed value only resets to market when the property sells.

Normally a sale includes inheritance, so your kids would face a big tax jump when they inherit the house. Prop 58 (1986) removed that for parent-child transfers, and Prop 193 (1996) extended it to grandparents when the parents are deceased, letting the low taxed value pass down with the property. Prop 19 (2021) narrowed this: the child now has to live in the home, and only the first $1M or so of the discount carries over. Transfers before 2021 kept the old, more generous rules.

## What's your privacy stance?

The site shows addresses, taxed values, and estimates, all derived from public open data, and no owner names. We publish it because who benefits from Prop 13, and by how much, is a public policy question, and the underlying records have always been public. We aim the spotlight at the system, not at any one household.

## Can I get my property removed?

If you're an individual, yes. Email us from an address you can verify, tell us the parcel, and we'll exclude it from the map and leaderboards. Following the SF Chronicle's approach with its Prop 13 project, this applies to people, not to companies, LLCs, or landlords of multi-unit buildings.

## Where does the data come from, and how often does it update?

Two DataSF open datasets: the Assessor's historical secured tax rolls (2007 to present) and the city's parcel map. The assessor roll is published once a year after the roll closes, and we rebuild the site when a new roll lands. The map currently covers a few neighborhoods, not the whole city.

## Is this legal?

Yes. Assessment rolls are public records under California law, and DataSF publishes these datasets openly for anyone to use. We add analysis on top, and we don't publish anything the city hasn't already released.

## Is it fair to publish this?

People disagree, and that's part of why the site exists. One view: these are public records about a tax system that shifts billions between neighbors, and you can't debate a policy you can't see. Another view: individual households didn't design Prop 13 and shouldn't be singled out for using it legally. We try to present the numbers neutrally, label inferences as inferences, and fix anything that turns out to be factually wrong.
