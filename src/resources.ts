// placeholder copy: the owner will rewrite every note in their own words.
// URLs were checked for a 2xx/3xx response. Printables (printables.com) returned 403 to curl, so it is left out.
export type Tool = { name: string; url: string; note: string; free: boolean };
export type Group = { title: string; tools: Tool[] };

export const RESOURCES_INTRO = "Makers Wanted helps you find people. These tools help your team build."; // placeholder copy

// Free / open-source tools first within each group.
export const RESOURCE_GROUPS: Group[] = [
  { title: "Plan & track", tools: [
    { name: "Kanboard", url: "https://kanboard.org", note: "Open-source kanban board you can host yourself.", free: true },
    { name: "GitHub Projects", url: "https://github.com/features/issues", note: "Issues and boards that live next to your code.", free: true },
    { name: "Trello", url: "https://trello.com", note: "Simple card boards, free tier available.", free: false },
  ] },
  { title: "Design & CAD", tools: [
    { name: "KiCad", url: "https://www.kicad.org", note: "Open-source schematic and PCB design.", free: true },
    { name: "FreeCAD", url: "https://www.freecad.org", note: "Open-source parametric 3D modeller.", free: true },
    { name: "OpenSCAD", url: "https://openscad.org", note: "Describe 3D parts in code.", free: true },
    { name: "Onshape", url: "https://www.onshape.com", note: "Browser-based CAD with a free hobbyist plan.", free: false },
  ] },
  { title: "Talk", tools: [
    { name: "Signal", url: "https://signal.org", note: "Private group chat, free and non-profit.", free: true },
    { name: "Matrix / Element", url: "https://element.io", note: "Open chat protocol with the Element app.", free: true },
    { name: "Discord", url: "https://discord.com", note: "Chat rooms and voice for communities.", free: false },
  ] },
  { title: "Share builds & docs", tools: [
    { name: "GitHub", url: "https://github.com", note: "Host code, files and documentation.", free: true },
    { name: "Hackaday.io", url: "https://hackaday.io", note: "Project pages and build logs for hardware.", free: true },
  ] },
  // TODO: add learning resources (tutorials, courses) once the owner picks them.
  { title: "Learn", tools: [] },
];
