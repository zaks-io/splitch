import { Button } from "@splitch/ui/components/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
} from "@splitch/ui/components/button-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { Checkbox } from "@splitch/ui/components/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@splitch/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@splitch/ui/components/input-group";
import { Kbd, KbdGroup } from "@splitch/ui/components/kbd";
import { Label } from "@splitch/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@splitch/ui/components/radio-group";
import { Slider } from "@splitch/ui/components/slider";
import { Spinner } from "@splitch/ui/components/spinner";
import { Switch } from "@splitch/ui/components/switch";
import { Textarea } from "@splitch/ui/components/textarea";
import { Toggle } from "@splitch/ui/components/toggle";

export function KitchenSinkForms() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Form controls</CardTitle>
        <CardDescription>
          Field, InputGroup, Checkbox, Switch, RadioGroup, Slider, ButtonGroup, Kbd, Spinner.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ks-flag-key">Flag key</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <InputGroupText>flag.</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput id="ks-flag-key" placeholder="checkout-cta" />
            </InputGroup>
            <FieldDescription>Machine-typed values render in mono.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="ks-hypothesis">Hypothesis</FieldLabel>
            <Textarea id="ks-hypothesis" placeholder="Treatment lifts checkout conversion." />
          </Field>

          <Field orientation="horizontal">
            <Checkbox defaultChecked id="ks-srm" />
            <FieldLabel htmlFor="ks-srm">Guard this Run with an SRM check</FieldLabel>
          </Field>

          <Field orientation="horizontal">
            <Switch defaultChecked id="ks-serve" />
            <FieldLabel htmlFor="ks-serve">Serve in dev</FieldLabel>
          </Field>
        </FieldGroup>

        <div className="grid content-start gap-6">
          <div className="grid gap-2">
            <Label>Allocation</Label>
            <Slider defaultValue={[50]} max={100} step={5} />
          </div>

          <RadioGroup className="grid gap-2" defaultValue="sequential">
            <Label className="text-muted-foreground text-xs uppercase">Inference</Label>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="ks-seq" value="sequential" />
              <Label htmlFor="ks-seq">Sequential (default)</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="ks-fixed" value="fixed" />
              <Label htmlFor="ks-fixed">Fixed horizon</Label>
            </div>
          </RadioGroup>

          <ButtonGroup>
            <Button variant="outline">Save draft</Button>
            <ButtonGroupSeparator />
            <Button>Start Run</Button>
            <ButtonGroupText>
              <KbdGroup>
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>
            </ButtonGroupText>
          </ButtonGroup>

          <div className="flex items-center gap-2">
            <Toggle aria-label="Pin" variant="outline">
              Pin
            </Toggle>
            <Spinner className="text-muted-foreground" />
            <span className="text-muted-foreground text-sm">Computing lift…</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
