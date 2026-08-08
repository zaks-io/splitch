import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

describe("SelectValue", () => {
  it("renders the selected item's label instead of its submitted value", () => {
    const html = renderToStaticMarkup(
      <Select value="member">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="owner">Owner</SelectItem>
            <SelectItem value="member">Member</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    expect(html).toMatch(/data-slot="select-value"[^>]*>Member<\/span>/u);
    expect(html).not.toMatch(/data-slot="select-value"[^>]*>member<\/span>/u);
  });
});
