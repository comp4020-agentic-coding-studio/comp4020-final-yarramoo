# Crit 10 reflection

1. What was the breakthrough that moved the work forward?
Having decided on a project and made a decent amount of progress into a solid medium-sized software project, 
the biggest breakthrough would be using some of the prompting techniques discussed in class to make long-running, 
and stable agentic coding sessions. Using multiple subagents with models selected based on task difficulty, and 
adversarial testers critiquing the implementation and writing better tests. 

Another important moment was just allowing time to pass since the last crit. With the architecture of this project 
relying on good network connection of clients, some bugs were exposed that wouldn't occur immediately after deployment, 
but would emerge over time. The server collects world snapshots from connected clients (the server never actually runs 
the simulation), but only a client that has caught up on the event log can produce one. Once the log got long, 
catching up took minutes, visitors left before they finished, and no new snapshot was saved for days. The 
server just accumulated an event log that grew longer and longer from the previous intact snapshot. This led to 
a stack overflow on the server and clients could no longer connect.

Lastly, with the project getting more complex and the codebase growing larger than I ever plan on reading, 
I've found that representing decisions, and sometimes problems, as images or graphs makes the human-in-the-loop a 
little bit tighter. Frankly I've been very hands off in some of the more complex bug fixes, and when claude suggested a number of fixes for a given problem that I didn't understand, I asked it to complete a small research task on other 
games and server architectures having similar issues. It was able to come back with a better explanation of the problem, 
but also more confidently say which fixes would be appropriate which I was happy to trust. BUT, visualising these fixes 
was important as it was my only real way of really understanding the problem without code-reviewing myself. 

2. What did this work change about who I want to be as a software developer?
I think that reasoning visually about software projects is something I've been sleeping on. There is a trust barrier 
in that the generated visualisations must be truly representative of the code, but adversarial agents in seperate 
contexts should be able to provide a higher level of assurance. 

I'll be generating more networking timelines, and system architecture charts from now on for anything deeply agentic. 
It looks like mermaid is another syntax that AI can just generate from scratch so it's easy and cheap to do. 

