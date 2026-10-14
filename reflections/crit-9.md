# Crit 9 reflection

1. What was the breakthrough that moved the work forward?
The biggest breakthrough was settling on a concept for the final assignment. I struggled a bit to find something that was was live, interactive, interesting (generally and to me personally), and also was a suitable challenge for AI to solve with the number of tokens available. Many of my ideas felt like they could be solved with ~$50 worth of tokens, and I wasn't sure how to continue extending them. 

I finally settled on a multiplayer cellular automata game inspired by Noita and Sandspiel. I have made small projects like these in the past and making the world simulation performant but also synchronised between players seemed like a good challenge. The networking and definition of updates and saved world state took considerable forethought and planning, which I did over the Claude browser which I find easier for interactive planning during an earlier crit project. Once the plan was finalised I summarised the plan into a prompt file located at docs/plan.md. 

The plan contained a detailed work package order which I instructed claude code to execute overnight, with budget estimations and limits between each step. With previous lessons-learned about budget blowout already in the harness, I let it run without much incident!

2. What did this work change about who I want to be as a software developer?
This work admittedly does deviate my thinking process in some ways from how I think I OUGHT to behave as a developer. Fitting a solution to the budget/resources available seems potentially wasteful. 

That said, it's not entirely unaligned particularly for an assignment. This idea has provided the opportunity to learn a lot about complex state synchronisation behaviour, and how to best use distributed compute to minimise network traffic and latency. I've generated an outline from the planning session at docs/lockstep-networking.png


