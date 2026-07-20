import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@splitch/ui/components/accordion";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@splitch/ui/components/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@splitch/ui/components/breadcrumb";
import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@splitch/ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@splitch/ui/components/popover";
import {
  Progress,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
} from "@splitch/ui/components/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@splitch/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@splitch/ui/components/tabs";

export function KitchenSinkOverlays() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Navigation and overlays</CardTitle>
        <CardDescription>
          Tabs, DropdownMenu, Popover, Sheet, Breadcrumb, Accordion, Avatar, Progress.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-6">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="#">acme</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink href="#">storefront</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>flags</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          <Tabs defaultValue="flags">
            <TabsList>
              <TabsTrigger value="flags">Flags</TabsTrigger>
              <TabsTrigger value="experiments">Experiments</TabsTrigger>
              <TabsTrigger value="metrics">Metrics</TabsTrigger>
            </TabsList>
            <TabsContent className="text-muted-foreground text-sm" value="flags">
              Flags control what ships.
            </TabsContent>
            <TabsContent className="text-muted-foreground text-sm" value="experiments">
              Experiments measure what changes.
            </TabsContent>
            <TabsContent className="text-muted-foreground text-sm" value="metrics">
              Metrics define what counts.
            </TabsContent>
          </Tabs>

          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" />}>
                Run actions
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Run #7</DropdownMenuLabel>
                <DropdownMenuItem>Clone into draft</DropdownMenuItem>
                <DropdownMenuItem>Export results</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive">Stop Run</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Popover>
              <PopoverTrigger render={<Button variant="outline" />}>Popover</PopoverTrigger>
              <PopoverContent className="text-sm">
                Popovers sit on the raised surface role.
              </PopoverContent>
            </Popover>

            <Sheet>
              <SheetTrigger render={<Button variant="outline" />}>Sheet</SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Side panel</SheetTitle>
                  <SheetDescription>Detail surfaces share the card role.</SheetDescription>
                </SheetHeader>
              </SheetContent>
            </Sheet>
          </div>
        </div>

        <div className="grid content-start gap-6">
          <div className="flex items-center gap-4">
            <AvatarGroup>
              <Avatar>
                <AvatarFallback>IS</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>AG</AvatarFallback>
              </Avatar>
              <AvatarGroupCount>+3</AvatarGroupCount>
            </AvatarGroup>
            <span className="text-muted-foreground text-sm">Humans and agents, one surface.</span>
          </div>

          <Progress value={62}>
            <div className="flex items-center justify-between gap-2">
              <ProgressLabel>Rollout</ProgressLabel>
              <ProgressValue />
            </div>
            <ProgressTrack />
          </Progress>

          <Accordion>
            <AccordionItem value="srm">
              <AccordionTrigger>What is an SRM check?</AccordionTrigger>
              <AccordionContent>
                Sample-ratio mismatch detection. If observed allocation drifts from the configured
                split, the result is flagged instead of silently reported.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="exposure">
              <AccordionTrigger>Why Exposures as denominator?</AccordionTrigger>
              <AccordionContent>
                Only units that actually saw a Variant belong in the analysis.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </CardContent>
    </Card>
  );
}
